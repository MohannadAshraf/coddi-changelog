/** Meta Marketing API client — activity log fetching only. */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Requested explicitly: the default field set does not include
// translated_event_type, and event_type alone is a snake_case code.
const FIELDS = [
  'event_time',
  'event_type',
  'translated_event_type',
  'extra_data',
  'object_id',
  'object_name',
  'actor_id',
  'actor_name',
  'application_name',
].join(',');

const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export class MetaError extends Error {}

/**
 * Fetch every activity in [since, until].
 *
 * Rule-driven events are returned too — they are filtered out of the rows
 * later, but are needed to build rule_context_prev_24h.
 */
export async function fetchActivities(env, since, until) {
  const params = new URLSearchParams({
    since: String(since),
    until: String(until),
    limit: String(PAGE_SIZE),
    fields: FIELDS,
  });

  // The token goes in the Authorization header, never the URL, so it cannot
  // leak into logs or the `paging.next` links Meta echoes back.
  let url = `${GRAPH_BASE}/act_${env.AD_ACCOUNT_ID}/activities?${params}`;
  const all = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.META_TOKEN}` },
    });
    const body = await res.text();

    if (!res.ok) {
      throw new MetaError(
        `Meta activities ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
      );
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new MetaError(`Meta activities returned non-JSON: ${body.slice(0, 200)}`);
    }

    const data = Array.isArray(json.data) ? json.data : [];
    all.push(...data);

    const next = json.paging?.next;
    if (!next || data.length === 0) return all;
    url = next;
  }

  throw new MetaError(
    `Meta activities exceeded ${MAX_PAGES} pages; widen the cron or lower the window`,
  );
}
