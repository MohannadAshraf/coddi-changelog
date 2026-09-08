/**
 * coddi-changelog — appends manual Meta ad account changes to a Google Sheet.
 *
 * The sheet is a human-facing change log: only changes made by Mohanad or Omar
 * become rows. Automated-rule actions and Meta system events are excluded from
 * the rows themselves but feed the rule_context_prev_24h column.
 */

import { fetchActivities } from './meta.js';
import {
  getAccessToken,
  readChangeIds,
  appendRows,
  applyColumnFormats,
} from './sheets.js';
import { buildRows, filterNewRows, toSheetRow, HEADERS } from './transform.js';

const CURSOR_KEY = 'last_run_unix';
/**
 * Column formats are applied once and remembered here. Bump the version to
 * re-apply after changing applyColumnFormats.
 */
const FORMAT_KEY = 'sheet_format_version';
const FORMAT_VERSION = '1';
/** Re-fetch an hour of already-seen events so a late-arriving event is caught. */
const OVERLAP_SECONDS = 3600;
/** First ever run has no cursor; look back a day rather than all of history. */
const COLD_START_SECONDS = 24 * 3600;

/**
 * One full cycle. Throws on any Meta or Sheets failure, which leaves the KV
 * cursor untouched so the next run retries the same window.
 */
async function run(env, { dryRun = false } = {}) {
  const now = Math.floor(Date.now() / 1000);

  const cursor = await env.CHANGELOG_KV.get(CURSOR_KEY);
  const since = cursor
    ? Number(cursor) - OVERLAP_SECONDS
    : now - COLD_START_SECONDS;

  const raw = await fetchActivities(env, since, now);
  const rows = buildRows(raw);

  const token = await getAccessToken(env);
  const { ids, rowCount, hasHeader } = await readChangeIds(env, token);
  const fresh = filterNewRows(rows, ids);

  const values = fresh.map(toSheetRow);
  if (rowCount === 0 && !hasHeader) values.unshift(HEADERS);

  const summary = {
    since,
    until: now,
    raw_events: raw.length,
    candidate_rows: rows.length,
    new_rows: fresh.length,
    skipped_as_duplicate: rows.length - fresh.length,
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
  // Only advanced after a fully successful cycle.
  await env.CHANGELOG_KV.put(CURSOR_KEY, String(now));

  return summary;
}

export default {
  /** Cron trigger — every 15 minutes. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      run(env).then(
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
    if (!dryRun && url.pathname !== '/run') {
      return new Response('Not found\n', { status: 404 });
    }

    try {
      const summary = await run(env, { dryRun });
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
