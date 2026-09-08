/**
 * Pure transformation logic for the coddi-changelog worker.
 *
 * Deliberately free of I/O and of any Workers-specific globals so it can be
 * unit tested with plain `node --test`.
 */

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * Humans whose changes belong in the sheet. Everything else is filtered out.
 *
 * Meta actor ids are app-scoped: the same person has a different id depending
 * on which app's token is reading the log. Both known ids are listed for each
 * person — the first pair is what the system-user token this worker uses
 * actually returns, the second is the same two people as seen through other
 * Meta surfaces.
 */
export const HUMAN_ACTORS = new Map([
  ['122158908416988713', 'Mohanad Ashraf'],
  ['10175294362345133', 'Omar Eissa'],
  ['61579661412455', 'Mohanad Ashraf'],
  ['740265132', 'Omar Eissa'],
]);

/**
 * Name fallback, so that rotating the token or the app — which changes every
 * actor id — degrades to "still logs the right people" rather than to a
 * silently empty sheet. Automated and system events are actor_name "Meta" and
 * are never matched here.
 */
export const HUMAN_ACTOR_NAMES = new Set(['Mohanad Ashraf', 'Omar Eissa']);

/** Automated-rule actor. Excluded from rows, but kept for rule_context. */
export const RULE_ACTOR_ID = '1051435468209173';

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

// The Graph API returns `event_type` as a stable snake_case code and
// `translated_event_type` as a localised English label. The labels are not
// stable enough to match on (Meta returns "...finishes ad review" from the
// Graph API but "...finishes Ad Review" through other surfaces), so codes are
// authoritative and the label is only a fallback for codes we have not seen.
const CODE_TO_LABEL = {
  update_ad_set_budget: 'Ad set budget updated',
  update_campaign_group_budget: 'Campaign budget updated',
  update_campaign_budget: 'Campaign budget updated',
  update_ad_set_run_status: 'Ad set status updated',
  update_campaign_run_status: 'Campaign status updated',
  update_ad_run_status: 'Ad status updated',
  create_ad_set: 'Ad set created',
  create_campaign_group: 'Campaign created',
  create_ad: 'Ad created',
  // Recognised so it can be explicitly dropped: it duplicates the
  // corresponding "Ad status updated" row.
  update_ad_run_status_to_be_set_after_review:
    'Updated status of ad after it finishes ad review',
};

/** label -> row shape. `exclude` marks a label we recognise but never emit. */
const LABEL_SPEC = {
  'ad set budget updated': { label: 'Ad set budget updated', level: 'Ad set', event: 'Budget EGP/day', category: 'BUD' },
  'campaign budget updated': { label: 'Campaign budget updated', level: 'Campaign', event: 'Budget EGP/day', category: 'BUD' },
  'ad set status updated': { label: 'Ad set status updated', level: 'Ad set', event: 'Status', category: 'STA' },
  'campaign status updated': { label: 'Campaign status updated', level: 'Campaign', event: 'Status', category: 'STA' },
  'ad status updated': { label: 'Ad status updated', level: 'Ad', event: 'Status', category: 'STA' },
  'ad set created': { label: 'Ad set created', level: 'Ad set', event: 'Created', category: 'CRE' },
  'campaign created': { label: 'Campaign created', level: 'Campaign', event: 'Created', category: 'CRE' },
  'ad created': { label: 'Ad created', level: 'Ad', event: 'Created', category: 'CRE' },
  'updated status of ad after it finishes ad review': { label: 'Updated status of ad after it finishes ad review', exclude: true },
};

/** Resolve a raw event to its row spec, or null if it is not of interest. */
export function classify(raw) {
  const label =
    CODE_TO_LABEL[raw?.event_type] ?? raw?.translated_event_type ?? raw?.event_type;
  if (typeof label !== 'string') return null;
  return LABEL_SPEC[label.trim().toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

/** `extra_data` arrives as a JSON string; tolerate an already-parsed object. */
export function parseExtraData(extra) {
  if (extra && typeof extra === 'object') return extra;
  if (typeof extra !== 'string' || extra === '') return {};
  try {
    const parsed = JSON.parse(extra);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Budget changes wrap their value one level deep:
//   "old_value": { "type": "payment_amount", "currency": "EGP", "old_value": 32805 }
function unwrap(side, value) {
  if (value && typeof value === 'object') {
    return value[side] ?? value.value ?? null;
  }
  return value ?? null;
}

/** Meta reports budgets in piastres (1/100 EGP). */
export function formatBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value == null ? '' : String(value);
  return (n / 100).toFixed(2);
}

function formatValue(category, side, value) {
  const inner = unwrap(side, value);
  if (inner == null) return '';
  return category === 'BUD' ? formatBudget(inner) : String(inner);
}

const PENDING = 'pending process';
const isPending = (v) =>
  String(v ?? '').trim().toLowerCase().replace(/_/g, ' ') === PENDING;

// ---------------------------------------------------------------------------
// Africa/Cairo formatting
//
// Egypt observes DST again since 2023, so the UTC offset is not a constant
// and Intl has to do the work.
// ---------------------------------------------------------------------------

const TZ = 'Africa/Cairo';

const numericFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23',
});
// Fixed rather than Intl-derived: locale month abbreviations differ between
// ICU builds (en-GB renders September as "Sept"), and the sheet format is a
// three-letter month.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(ms) {
  const out = {};
  for (const { type, value } of numericFmt.formatToParts(new Date(ms))) {
    out[type] = value;
  }
  return out;
}

/** "YYYY-MM-DD HH:MM" */
export function cairoDateTime(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DD" — the grouping key's calendar date. */
export function cairoDateKey(ms) {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "YYYYMMDDTHHMM" — the change_id timestamp. */
export function cairoStamp(ms) {
  const p = parts(ms);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}`;
}

/** "07 Sep 14:30" — used inside rule_context_prev_24h. */
export function cairoShort(ms) {
  const p = parts(ms);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.hour}:${p.minute}`;
}

/** Graph API returns "2026-09-08T11:47:12+0000"; also accept unix seconds. */
export function parseEventTime(value) {
  if (typeof value === 'number') return value * 1000;
  if (typeof value !== 'string') return NaN;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Normalise "+0000" to "+00:00" — the bare form is not spec-guaranteed.
  return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Strip the "CODDI " prefix and the " | YYYY-MM" period from a rule name. */
export function cleanRuleName(name) {
  return String(name ?? '')
    .replace(/^CODDI\s+/i, '')
    .replace(/\s*\|\s*\d{4}-\d{2}(?=\s*\||\s*$)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn a raw activity into a normalised record, or null if it is an event type
 * we do not track at all.
 */
export function normalizeEvent(raw) {
  const spec = classify(raw);
  if (!spec) return null;

  const ts = parseEventTime(raw.event_time);
  if (!Number.isFinite(ts)) return null;

  const extra = parseExtraData(raw.extra_data);
  const ruleInfo = extra.rule_info ?? null;
  const actorId = String(raw.actor_id ?? '');

  return {
    ts,
    actorId,
    actorName: raw.actor_name ?? '',
    objectId: String(raw.object_id ?? ''),
    objectName: raw.object_name ?? '',
    label: spec.label,
    level: spec.level ?? '',
    event: spec.event ?? '',
    category: spec.category ?? '',
    exclude: Boolean(spec.exclude),
    from: formatValue(spec.category, 'old_value', extra.old_value),
    to: formatValue(spec.category, 'new_value', extra.new_value),
    isRule: actorId === RULE_ACTOR_ID || Boolean(ruleInfo),
    ruleName: ruleInfo ? ruleInfo.rule_name ?? ruleInfo.rule_latest_name ?? '' : '',
  };
}

/** A row belongs in the sheet only if a tracked human made a tracked change. */
export function isHumanRow(n) {
  if (!n || n.exclude || n.isRule) return false;
  return HUMAN_ACTORS.has(n.actorId) || HUMAN_ACTOR_NAMES.has(n.actorName);
}

// ---------------------------------------------------------------------------
// Collapsing
// ---------------------------------------------------------------------------

function firstMeaningful(events, key) {
  const hit = events.find((e) => e[key] !== '' && !isPending(e[key]));
  return hit ? hit[key] : events[0]?.[key] ?? '';
}

function lastMeaningful(events, key) {
  for (let i = events.length - 1; i >= 0; i--) {
    const v = events[i][key];
    if (v !== '' && !isPending(v)) return v;
  }
  return events[events.length - 1]?.[key] ?? '';
}

/**
 * Collapse one (object_id, category, Cairo date) group into a single row.
 *
 * Status edits fire several raw events (Active -> Pending Process -> Inactive);
 * the Pending Process staging value is never the answer, so it is skipped at
 * both ends.
 */
export function collapseGroup(events) {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const first = ordered[0];

  const from = firstMeaningful(ordered, 'from');
  const to = lastMeaningful(ordered, 'to');

  const flags = [];
  // The canonical Active -> Pending Process -> Inactive edit is 2 events once
  // the ad-review duplicate is dropped, so >2 means the object really was
  // toggled back and forth.
  if (ordered.length > 2) flags.push(`[toggled x${ordered.length}, net shown]`);
  // Never dropped silently: a no-op round trip is still a human action.
  if (from === to) flags.push('[no net change]');

  const actors = [...new Set(ordered.map((e) => e.actorName).filter(Boolean))];

  return {
    ts: first.ts,
    change_id: `${cairoStamp(first.ts)}_${first.objectId}_${first.category}`,
    datetime: cairoDateTime(first.ts),
    actor: actors.join(' / '),
    level: first.level,
    object_name: first.objectName,
    object_id: first.objectId,
    event: first.event,
    from,
    to,
    flags,
    eventCount: ordered.length,
  };
}

// ---------------------------------------------------------------------------
// Rule context
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most recent rule-driven change to the same object in the 24h before the
 * row. This column is the point of the sheet: it shows a human editing on top
 * of an automated rule.
 */
export function ruleContextFor(row, ruleEvents) {
  let best = null;
  for (const r of ruleEvents) {
    if (r.objectId !== row.object_id) continue;
    if (r.ts > row.ts || r.ts < row.ts - DAY_MS) continue;
    if (!best || r.ts > best.ts) best = r;
  }
  if (!best) return '';
  const name = cleanRuleName(best.ruleName) || 'Automated rule';
  // Both ends of the rule's move, so a scale-up reads differently from a cut
  // or a kill. Falls back to the single value when there is no old value —
  // a rule that created or first set something.
  const move = best.from ? `${best.from} → ${best.to}` : best.to;
  return `${name} set ${move} at ${cairoShort(best.ts)}`;
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

export const HEADERS = [
  'change_id', 'datetime', 'actor', 'level', 'object_name', 'object_id',
  'event', 'from', 'to', 'rule_context_prev_24h', 'why',
];

/**
 * The sheet is written with valueInputOption=USER_ENTERED, so a cell starting
 * with "=" would be evaluated as a formula. Object names are arbitrary text.
 */
function safeCell(value) {
  const s = value == null ? '' : String(value);
  return /^[=+@]/.test(s) ? `'${s}` : s;
}

/** Row object -> the exact column order the sheet expects. */
export function toSheetRow(row) {
  return [
    row.change_id, row.datetime, row.actor, row.level, row.object_name,
    row.object_id, row.event, row.from, row.to, row.rule_context_prev_24h,
    row.why,
  ].map(safeCell);
}

/**
 * Raw Meta activities -> sheet-ready rows, oldest first.
 *
 * Rule-driven events are kept through the fetch and used for rule_context, but
 * never become rows of their own.
 */
export function buildRows(rawEvents) {
  const normalized = [];
  for (const raw of rawEvents ?? []) {
    const n = normalizeEvent(raw);
    if (n) normalized.push(n);
  }

  const ruleEvents = normalized.filter((n) => n.isRule && !n.exclude);
  const humanEvents = normalized.filter(isHumanRow);

  const groups = new Map();
  for (const e of humanEvents) {
    const key = `${e.objectId}|${e.category}|${cairoDateKey(e.ts)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }

  const rows = [];
  for (const group of groups.values()) {
    const row = collapseGroup(group);
    const context = ruleContextFor(row, ruleEvents);
    row.rule_context_prev_24h = [context, ...row.flags].filter(Boolean).join(' ');
    // Always empty. Humans fill this in; the worker only ever appends new rows,
    // so an existing non-empty why can never be overwritten.
    row.why = '';
    delete row.flags;
    rows.push(row);
  }

  rows.sort((a, b) => a.ts - b.ts || a.change_id.localeCompare(b.change_id));
  return rows;
}

/** Drop rows whose change_id is already in column A of the sheet. */
export function filterNewRows(rows, existingIds) {
  const seen = existingIds instanceof Set ? existingIds : new Set(existingIds ?? []);
  const out = [];
  for (const row of rows) {
    if (seen.has(row.change_id)) continue;
    // Also guard against a duplicate inside this same batch.
    seen.add(row.change_id);
    out.push(row);
  }
  return out;
}
