/**
 * coddi-changelog — appends manual Meta ad account changes to a Google Sheet.
 *
 * The sheet is a human-facing change log: only changes made by Mohanad or Omar
 * become rows. Automated-rule actions and Meta system events are excluded from
 * the rows themselves but feed the rule_context_prev_24h column.
 *
 * Two sources feed it. The activity log is primary and is the only one that
 * knows who made a change. Because that log demonstrably omits some changes,
 * entity status is also snapshotted each run and diffed, recovering what the
 * log missed at the cost of not knowing the actor.
 */

import { fetchActivities } from './meta.js';
import {
  getAccessToken,
  readChangeIds,
  appendRows,
  applyColumnFormats,
} from './sheets.js';
import { fetchStatusSnapshot, diffSnapshots, compactSnapshot } from './state.js';
import {
  buildRows,
  normalizeAll,
  buildStateDiffRows,
  buildReconciliationRows,
  filterNewRows,
  parseEventTime,
  toSheetRow,
  HEADERS,
} from './transform.js';

const CURSOR_KEY = 'last_run_unix';
/**
 * Column formats are applied once and remembered here. Bump the version to
 * re-apply after changing applyColumnFormats.
 */
const FORMAT_KEY = 'sheet_format_version';
// v2: re-applied after deleting rows stripped the per-cell formats.
const FORMAT_VERSION = '2';
/** Last seen status of every campaign, ad set and ad, for state diffing. */
const SNAPSHOT_KEY = 'status_snapshot';
/**
 * Re-fetch an hour of already-seen events so a late-arriving event is caught.
 *
 * Do not widen this without changing how change_id is derived. A row's id comes
 * from the earliest event in its (object, category, day) group, so a wider
 * window would re-collapse an afternoon change into the morning group, find
 * that id already in the sheet, and drop the change instead of logging it.
 */
const OVERLAP_SECONDS = 3600;
/** First ever run has no cursor; look back a day rather than all of history. */
const COLD_START_SECONDS = 24 * 3600;
/**
 * How far back reconciliation reads the activity log, to establish each
 * object's last logged status. It only has to reach the last status event per
 * object, not the beginning of time.
 */
const RECONCILE_LOOKBACK_SECONDS = 30 * 24 * 3600;
/** How far back reconciliation may place a recovered change. */
const RECONCILE_EMIT_SECONDS = 48 * 3600;
/** Daily reconciliation sweep, alongside the 2-hourly incremental run. */
const RECONCILE_CRON = '30 3 * * *';

/**
 * One full cycle. Throws on any Meta or Sheets failure, which leaves the KV
 * cursor untouched so the next run retries the same window.
 */
async function run(env, { dryRun = false, reconcile = false, emitSince = null } = {}) {
  const now = Math.floor(Date.now() / 1000);

  const cursor = await env.CHANGELOG_KV.get(CURSOR_KEY);
  const incrementalSince = cursor
    ? Number(cursor) - OVERLAP_SECONDS
    : now - COLD_START_SECONDS;
  // Reconciliation needs enough history to find each object's last logged
  // status, which is usually far older than the incremental window.
  const since = reconcile
    ? Math.min(incrementalSince, now - RECONCILE_LOOKBACK_SECONDS)
    : incrementalSince;

  const raw = await fetchActivities(env, since, now);
  // A reconciliation sweep reads a much wider window, but only to learn each
  // object's last logged status and its rule context. Attributed rows must
  // still come from the incremental window, or every sweep would re-emit weeks
  // of already-reviewed history.
  const rows = buildRows(
    reconcile
      ? raw.filter((e) => parseEventTime(e.event_time) >= incrementalSince * 1000)
      : raw,
  );

  // Meta's activity log misses some changes entirely, so entity status is also
  // snapshotted and diffed. On the very first run there is no previous
  // snapshot: store the baseline and report nothing, rather than reporting the
  // whole account as changed.
  const snapshot = await fetchStatusSnapshot(env);
  const previous = await env.CHANGELOG_KV.get(SNAPSHOT_KEY, 'json');
  const normalized = normalizeAll(raw);
  const diffRows = buildStateDiffRows(
    diffSnapshots(previous, snapshot),
    normalized,
    now * 1000,
  );

  // Snapshot diffing only sees changes that happen between two runs, so
  // anything Meta failed to log before the first snapshot is invisible to it
  // forever. Reconciliation catches those by comparing live status against the
  // last status the log recorded.
  const reconciledRows = reconcile
    ? buildReconciliationRows(snapshot, normalized, {
        detectedAtMs: now * 1000,
        notBeforeMs: (emitSince ?? now - RECONCILE_EMIT_SECONDS) * 1000,
      })
    : [];

  const allRows = [...rows, ...diffRows, ...reconciledRows].sort(
    (a, b) => a.ts - b.ts || a.change_id.localeCompare(b.change_id),
  );

  const token = await getAccessToken(env);
  const { ids, rowCount, hasHeader } = await readChangeIds(env, token);
  const fresh = filterNewRows(allRows, ids);

  const values = fresh.map(toSheetRow);
  if (rowCount === 0 && !hasHeader) values.unshift(HEADERS);

  const summary = {
    since,
    until: now,
    raw_events: raw.length,
    candidate_rows: allRows.length,
    from_activity_log: rows.length,
    from_state_diff: diffRows.length,
    from_reconciliation: reconciledRows.length,
    reconcile,
    snapshot_size: Object.keys(snapshot).length,
    snapshot_baseline: previous === null,
    new_rows: fresh.length,
    skipped_as_duplicate: allRows.length - fresh.length,
    existing_ids: ids.size,
    dry_run: dryRun,
  };

  if (dryRun) return { ...summary, rows: fresh };

  // Cosmetic and one-off: a failure here must not stop the log from being
  // written, so it is logged and swallowed rather than failing the run.
  if ((await env.CHANGELOG_KV.get(FORMAT_KEY)) !== FORMAT_VERSION) {
    try {
      await applyColumnFormats(env, token);
      await env.CHANGELOG_KV.put(FORMAT_KEY, FORMAT_VERSION);
      summary.formats_applied = true;
    } catch (err) {
      console.warn('column formatting failed, continuing:', String(err?.message ?? err));
      summary.formats_applied = false;
    }
  }

  // Single append call: all rows land or none do.
  await appendRows(env, token, values);
  // Both only advanced after a fully successful cycle. If the append throws,
  // the snapshot is not saved either, so a diff detected this run is detected
  // again next run rather than being lost.
  await env.CHANGELOG_KV.put(CURSOR_KEY, String(now));
  await env.CHANGELOG_KV.put(SNAPSHOT_KEY, JSON.stringify(compactSnapshot(snapshot)));

  return summary;
}

export default {
  /**
   * Cron triggers: the 2-hourly incremental run, plus a daily reconciliation
   * sweep that also catches changes Meta never logged at all.
   */
  async scheduled(event, env, ctx) {
    const reconcile = event.cron === RECONCILE_CRON;
    ctx.waitUntil(
      run(env, { reconcile }).then(
        (summary) => console.log('coddi-changelog ok', JSON.stringify(summary)),
        (err) => {
          console.error('coddi-changelog failed:', err?.stack ?? String(err));
          // Rethrown so the invocation is recorded as an error, not a success.
          throw err;
        },
      ),
    );
  },

  /**
   * Manual trigger, for the first run and for debugging. Requires the optional
   * RUN_TOKEN secret; without it the endpoints are closed.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }

    if (!env.RUN_TOKEN || url.searchParams.get('token') !== env.RUN_TOKEN) {
      return new Response('Forbidden\n', { status: 403 });
    }

    const dryRun = url.pathname === '/dry-run';
    const reconcile =
      url.pathname === '/reconcile' || url.searchParams.get('reconcile') === '1';
    if (!dryRun && !reconcile && url.pathname !== '/run') {
      return new Response('Not found\n', { status: 404 });
    }

    // ?since=YYYY-MM-DD (Africa/Cairo) bounds how far back a reconciliation
    // sweep may place recovered rows. Defaults to the last 48 hours.
    const sinceParam = url.searchParams.get('since');
    const emitSince = sinceParam
      ? Math.floor(Date.parse(`${sinceParam}T00:00:00+03:00`) / 1000)
      : null;
    if (sinceParam && !Number.isFinite(emitSince)) {
      return new Response('Bad since= date, expected YYYY-MM-DD\n', { status: 400 });
    }

    try {
      const summary = await run(env, { dryRun, reconcile, emitSince });
      return Response.json(summary);
    } catch (err) {
      console.error('coddi-changelog failed:', err?.stack ?? String(err));
      // Non-200 so the failure is visible rather than silently swallowed.
      return Response.json(
        { ok: false, error: String(err?.message ?? err) },
        { status: 500 },
      );
    }
  },
};
