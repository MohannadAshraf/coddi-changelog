/**
 * Entity status snapshots.
 *
 * Meta's activity log is not complete: an ad can be paused with no
 * corresponding activity event ever written (observed on ad
 * 120252068912490136, paused 2026-09-08 with no log entry in 30 days). The
 * activity log alone therefore cannot produce a complete change log.
 *
 * This module reads the configured status of every campaign, ad set and ad on
 * each run so the worker can diff consecutive snapshots and recover changes the
 * log missed.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export class StateError extends Error {}

// `status` is the object's own configured status. `effective_status` is
// deliberately not used: it also reflects the parent's state, so pausing one ad
// set would otherwise look like every ad beneath it changed.
const EDGES = [
  { edge: 'campaigns', level: 'Campaign' },
  { edge: 'adsets', level: 'Ad set' },
  { edge: 'ads', level: 'Ad' },
];

async function fetchEdge(env, edge) {
  const params = new URLSearchParams({
    fields: 'id,name,status',
    limit: String(PAGE_SIZE),
  });
  let url = `${GRAPH_BASE}/act_${env.AD_ACCOUNT_ID}/${edge}?${params}`;
  const out = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.META_TOKEN}` },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new StateError(
        `Meta ${edge} ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
      );
    }
    const json = JSON.parse(body);
    const data = Array.isArray(json.data) ? json.data : [];
    out.push(...data);

    const next = json.paging?.next;
    if (!next || data.length === 0) return out;
    url = next;
  }
  throw new StateError(`Meta ${edge} exceeded ${MAX_PAGES} pages`);
}

/**
 * Current status of every campaign, ad set and ad, as
 * `{ [objectId]: { level, status, name } }`.
 */
export async function fetchStatusSnapshot(env) {
  const snapshot = {};
  for (const { edge, level } of EDGES) {
    for (const obj of await fetchEdge(env, edge)) {
      if (!obj?.id) continue;
      snapshot[obj.id] = { level, status: obj.status ?? '', name: obj.name ?? '' };
    }
  }
  return snapshot;
}

/**
 * The form stored in KV: `{ [objectId]: status }`.
 *
 * This account has ~6,800 objects, so keeping level and name as well would
 * write ~575 KB on every run to record something only the current snapshot
 * needs — the diff compares status, and the row is built from the current
 * names.
 */
export function compactSnapshot(snapshot) {
  const out = {};
  for (const [id, entry] of Object.entries(snapshot)) out[id] = entry.status;
  return out;
}

/**
 * Objects whose status changed, comparing a stored compact snapshot against a
 * freshly fetched one.
 *
 * Only objects present in both are considered. An object that appears is a
 * creation and an object that disappears was archived or deleted; the activity
 * log covers creations, and neither should be reported as a status change.
 */
export function diffSnapshots(previous, current) {
  const diffs = [];
  if (!previous) return diffs;

  for (const [objectId, now] of Object.entries(current)) {
    const before = previous[objectId];
    if (!before || !now.status || before === now.status) continue;
    diffs.push({
      objectId,
      level: now.level,
      name: now.name,
      from: before,
      to: now.status,
    });
  }
  return diffs;
}
