import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRows,
  filterNewRows,
  formatBudget,
  cleanRuleName,
  cairoStamp,
  parseEventTime,
  normalizeEvent,
  toSheetRow,
  HEADERS,
} from '../src/transform.js';

// ---------------------------------------------------------------------------
// Fixtures — shapes copied verbatim from act_904315886897104.
// ---------------------------------------------------------------------------

// The app-scoped ids this worker's system-user token actually sees.
const MOHANAD = { actor_id: '122158908416988713', actor_name: 'Mohanad Ashraf' };
const OMAR = { actor_id: '10175294362345133', actor_name: 'Omar Eissa' };
const RULE = { actor_id: '1051435468209173', actor_name: 'Meta' };

/** A status-change activity. Values are the literal strings Meta returns. */
function statusEvent({ time, actor, objectId, from, to, code = 'update_ad_run_status', name = 'Some Ad', rule = null }) {
  const extra = { old_value: from, new_value: to, type: 'run_status' };
  if (rule) extra.rule_info = { rule_name: rule, rule_latest_name: rule };
  return {
    event_time: time,
    event_type: code,
    translated_event_type: 'Ad status updated',
    extra_data: JSON.stringify(extra),
    object_id: objectId,
    object_name: name,
    ...actor,
  };
}

/** A budget-change activity. Note the value is nested one level deep. */
function budgetEvent({ time, actor, objectId, fromPiastres, toPiastres, name = 'Some Ad Set', rule = null }) {
  const extra = {
    old_value: { type: 'payment_amount', currency: 'EGP', old_value: fromPiastres },
    new_value: { type: 'payment_amount', currency: 'EGP', new_value: toPiastres, additional_value: 'Per day' },
    type: 'composite_data',
  };
  if (rule) extra.rule_info = { rule_name: rule, rule_latest_name: rule };
  return {
    event_time: time,
    event_type: 'update_ad_set_budget',
    translated_event_type: 'Ad set budget updated',
    extra_data: JSON.stringify(extra),
    object_id: objectId,
    object_name: name,
    ...actor,
  };
}

// ---------------------------------------------------------------------------
// Status collapsing
// ---------------------------------------------------------------------------

test('collapses the Active -> Pending Process -> Inactive sequence into one row', () => {
  const events = [
    statusEvent({ time: '2026-09-07T10:56:00+0000', actor: MOHANAD, objectId: '120251885824920136', from: 'Active', to: 'Pending Process' }),
    statusEvent({ time: '2026-09-07T10:56:30+0000', actor: MOHANAD, objectId: '120251885824920136', from: 'Pending Process', to: 'Inactive' }),
    // The ad-review event Meta fires alongside; a duplicate of the above.
    {
      event_time: '2026-09-07T10:56:00+0000',
      event_type: 'update_ad_run_status_to_be_set_after_review',
      translated_event_type: 'Updated status of ad after it finishes ad review',
      extra_data: JSON.stringify({ old_value: 'Active', new_value: 'Inactive' }),
      object_id: '120251885824920136',
      object_name: 'Some Ad',
      ...MOHANAD,
    },
  ];

  const rows = buildRows(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, 'Active');
  assert.equal(rows[0].to, 'Inactive');
  // Earliest event in the group, in Cairo (UTC+3 on this date).
  assert.equal(rows[0].datetime, '2026-09-07 13:56');
  assert.equal(rows[0].level, 'Ad');
  assert.equal(rows[0].event, 'Status');
  // Two real events after the ad-review duplicate is dropped: not a toggle.
  assert.equal(rows[0].rule_context_prev_24h, '');
});

test('drops the ad-review duplicate even when it is the only tracked event', () => {
  const rows = buildRows([
    {
      event_time: '2026-09-07T10:56:00+0000',
      event_type: 'update_ad_run_status_to_be_set_after_review',
      translated_event_type: 'Updated status of ad after it finishes Ad Review',
      extra_data: JSON.stringify({ old_value: 'Active', new_value: 'Inactive' }),
      object_id: '1',
      object_name: 'Ad',
      ...MOHANAD,
    },
  ]);
  assert.deepEqual(rows, []);
});

test('off/on/off toggle collapses to net change and is flagged', () => {
  const events = [
    statusEvent({ time: '2026-09-08T10:24:00+0000', actor: MOHANAD, objectId: '120251357475870136', from: 'Active', to: 'Inactive', code: 'update_ad_set_run_status' }),
    statusEvent({ time: '2026-09-08T10:24:40+0000', actor: MOHANAD, objectId: '120251357475870136', from: 'Inactive', to: 'Active', code: 'update_ad_set_run_status' }),
    statusEvent({ time: '2026-09-08T10:26:00+0000', actor: MOHANAD, objectId: '120251357475870136', from: 'Active', to: 'Inactive', code: 'update_ad_set_run_status' }),
  ];

  const rows = buildRows(events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, 'Active');
  assert.equal(rows[0].to, 'Inactive');
  assert.equal(rows[0].rule_context_prev_24h, '[toggled x3, net shown]');
});

test('a no-net-change round trip is emitted and flagged, never dropped', () => {
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T09:00:00+0000', actor: OMAR, objectId: '999', from: 'Inactive', to: 'Active' }),
    statusEvent({ time: '2026-09-08T09:30:00+0000', actor: OMAR, objectId: '999', from: 'Active', to: 'Inactive' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, 'Inactive');
  assert.equal(rows[0].to, 'Inactive');
  assert.equal(rows[0].rule_context_prev_24h, '[no net change]');
});

test('a creation is not flagged as a no-net-change round trip', () => {
  const rows = buildRows([
    {
      event_time: '2026-09-02T10:26:00+0000',
      event_type: 'create_campaign_group',
      translated_event_type: 'Campaign created',
      extra_data: '{}',
      object_id: '120252094628620136',
      object_name: 'Sales | Testing',
      ...OMAR,
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'Created');
  assert.equal(rows[0].from, '');
  assert.equal(rows[0].to, '');
  assert.equal(rows[0].rule_context_prev_24h, '');
});

test('the same object on different calendar dates stays two rows', () => {
  const rows = buildRows([
    statusEvent({ time: '2026-09-07T20:00:00+0000', actor: OMAR, objectId: '999', from: 'Active', to: 'Inactive' }),
    // 21:30 UTC is 00:30 the next day in Cairo.
    statusEvent({ time: '2026-09-07T21:30:00+0000', actor: OMAR, objectId: '999', from: 'Inactive', to: 'Active' }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].datetime, '2026-09-07 23:00');
  assert.equal(rows[1].datetime, '2026-09-08 00:30');
});

test('budget and status changes to one object on one day stay separate rows', () => {
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T09:00:00+0000', actor: OMAR, objectId: '555', from: 'Active', to: 'Inactive', code: 'update_ad_set_run_status' }),
    budgetEvent({ time: '2026-09-08T09:05:00+0000', actor: OMAR, objectId: '555', fromPiastres: 32805, toPiastres: 45000 }),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.event).sort(), ['Budget EGP/day', 'Status']);
});

// ---------------------------------------------------------------------------
// Piastre division
// ---------------------------------------------------------------------------

test('formatBudget divides piastres by 100 with two decimals', () => {
  assert.equal(formatBudget(45000), '450.00');
  assert.equal(formatBudget(32805), '328.05');
  assert.equal(formatBudget(193600), '1936.00');
  assert.equal(formatBudget(22964), '229.64');
  assert.equal(formatBudget(1), '0.01');
  assert.equal(formatBudget('40095'), '400.95');
});

test('budget rows unwrap the nested payment_amount object', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '120251978713910136', fromPiastres: 32805, toPiastres: 45000 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from, '328.05');
  assert.equal(rows[0].to, '450.00');
  assert.equal(rows[0].event, 'Budget EGP/day');
  assert.equal(rows[0].level, 'Ad set');
});

test('status values are passed through as strings, not divided', () => {
  const n = normalizeEvent(
    statusEvent({ time: '2026-09-08T09:00:00+0000', actor: OMAR, objectId: '1', from: 'Active', to: 'Inactive' }),
  );
  assert.equal(n.from, 'Active');
  assert.equal(n.to, 'Inactive');
});

// ---------------------------------------------------------------------------
// change_id determinism
// ---------------------------------------------------------------------------

test('change_id is deterministic across runs', () => {
  const events = [
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '120251978713910136', fromPiastres: 32805, toPiastres: 45000 }),
  ];
  const first = buildRows(events)[0].change_id;
  const second = buildRows(events)[0].change_id;
  assert.equal(first, second);
  assert.equal(first, '20260908T1009_120251978713910136_BUD');
});

test('change_id is stable when the same group is re-fetched with extra events', () => {
  const base = statusEvent({ time: '2026-09-08T10:24:00+0000', actor: MOHANAD, objectId: '42', from: 'Active', to: 'Pending Process' });
  const later = statusEvent({ time: '2026-09-08T10:26:00+0000', actor: MOHANAD, objectId: '42', from: 'Pending Process', to: 'Inactive' });

  // The overlap window may return the first event alone, then both.
  assert.equal(buildRows([base])[0].change_id, buildRows([base, later])[0].change_id);
});

test('change_id encodes level via the category suffix', () => {
  const suffix = (row) => row.change_id.split('_').pop();
  assert.equal(suffix(buildRows([budgetEvent({ time: '2026-09-08T07:00:00+0000', actor: OMAR, objectId: '1', fromPiastres: 100, toPiastres: 200 })])[0]), 'BUD');
  assert.equal(suffix(buildRows([statusEvent({ time: '2026-09-08T07:00:00+0000', actor: OMAR, objectId: '2', from: 'Active', to: 'Inactive' })])[0]), 'STA');
  assert.equal(
    suffix(
      buildRows([
        {
          event_time: '2026-09-08T07:00:00+0000',
          event_type: 'create_ad_set',
          translated_event_type: 'Ad set created',
          extra_data: '{}',
          object_id: '3',
          object_name: 'New Ad Set',
          ...OMAR,
        },
      ])[0],
    ),
    'CRE',
  );
});

test('cairoStamp respects Egypt DST', () => {
  // 08 Sep 2026 is inside DST (UTC+3).
  assert.equal(cairoStamp(Date.parse('2026-09-08T07:09:00Z')), '20260908T1009');
  // 08 Jan 2026 is outside DST (UTC+2).
  assert.equal(cairoStamp(Date.parse('2026-01-08T07:09:00Z')), '20260108T0909');
});

test('parseEventTime handles the +0000 offset Meta returns', () => {
  assert.equal(
    parseEventTime('2026-09-08T11:47:12+0000'),
    Date.parse('2026-09-08T11:47:12Z'),
  );
  assert.equal(parseEventTime(1788516465), 1788516465000);
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

test('rows already present in column A are skipped', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '111', fromPiastres: 100, toPiastres: 200 }),
    budgetEvent({ time: '2026-09-08T08:09:00+0000', actor: OMAR, objectId: '222', fromPiastres: 300, toPiastres: 400 }),
  ]);
  assert.equal(rows.length, 2);

  const existing = new Set(['change_id', rows[0].change_id]);
  const fresh = filterNewRows(rows, existing);

  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].change_id, rows[1].change_id);
});

test('a re-run over the overlap window appends nothing', () => {
  const events = [
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '111', fromPiastres: 100, toPiastres: 200 }),
    statusEvent({ time: '2026-09-08T08:09:00+0000', actor: MOHANAD, objectId: '222', from: 'Active', to: 'Inactive' }),
  ];
  const firstPass = filterNewRows(buildRows(events), new Set());
  assert.equal(firstPass.length, 2);

  const sheet = new Set(firstPass.map((r) => r.change_id));
  assert.deepEqual(filterNewRows(buildRows(events), sheet), []);
});

test('filterNewRows also collapses a duplicate inside one batch', () => {
  const row = { change_id: 'X' };
  assert.equal(filterNewRows([row, row], new Set()).length, 1);
});

// ---------------------------------------------------------------------------
// Actor and event filtering
// ---------------------------------------------------------------------------

test('rule-driven and system events never become rows', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-08T06:13:00+0000', actor: RULE, objectId: '777', fromPiastres: 45000, toPiastres: 40500, rule: 'CODDI AUTOSCALE-P | 2026-09 | Testing' }),
    {
      event_time: '2026-09-08T11:47:12+0000',
      event_type: 'ad_account_billing_charge',
      translated_event_type: 'Account billed',
      extra_data: JSON.stringify({ currency: 'EGP', new_value: 1503806 }),
      object_id: '904315886897104',
      object_name: 'Coddiwomple',
      actor_id: '0',
      actor_name: 'Meta',
    },
  ]);
  assert.deepEqual(rows, []);
});

test('both app-scoped id sets for the same human are accepted', () => {
  const legacy = { actor_id: '61579661412455', actor_name: 'Mohanad Ashraf' };
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T09:00:00+0000', actor: legacy, objectId: '1', from: 'Active', to: 'Inactive' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'Mohanad Ashraf');
});

test('an unknown actor id still matches on name, so a token rotation cannot empty the sheet', () => {
  const rotated = { actor_id: '999999999999999', actor_name: 'Omar Eissa' };
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T09:00:00+0000', actor: rotated, objectId: '1', from: 'Active', to: 'Inactive' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor, 'Omar Eissa');
});

test('an unrelated human is not logged', () => {
  const stranger = { actor_id: '123', actor_name: 'Someone Else' };
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T09:00:00+0000', actor: stranger, objectId: '1', from: 'Active', to: 'Inactive' }),
  ]);
  assert.deepEqual(rows, []);
});

test('untracked event types are ignored', () => {
  const rows = buildRows([
    {
      event_time: '2026-09-08T09:00:00+0000',
      event_type: 'update_ad_set_target_spec',
      translated_event_type: 'Ad set targeting updated',
      extra_data: '{}',
      object_id: '1',
      object_name: 'Ad Set',
      ...MOHANAD,
    },
  ]);
  assert.deepEqual(rows, []);
});

// ---------------------------------------------------------------------------
// rule_context_prev_24h
// ---------------------------------------------------------------------------

test('a human edit on top of a rule carries the rule context', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-08T06:42:00+0000', actor: RULE, objectId: '120251978713910136', fromPiastres: 36450, toPiastres: 32805, rule: 'CODDI AUTOSCALE-P | 2026-09 | Testing' }),
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '120251978713910136', fromPiastres: 32805, toPiastres: 45000 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].rule_context_prev_24h,
    'AUTOSCALE-P | Testing set 364.50 → 328.05 at 08 Sep 09:42',
  );
});

test('rule context shows direction, so a scale-up reads differently from a cut', () => {
  const scaleUp = buildRows([
    budgetEvent({ time: '2026-09-08T04:12:00+0000', actor: RULE, objectId: 'A', fromPiastres: 176000, toPiastres: 193600, rule: 'CODDI AUTOSCALE-S | 2026-09 | Catalogue' }),
    budgetEvent({ time: '2026-09-08T06:55:00+0000', actor: OMAR, objectId: 'A', fromPiastres: 193600, toPiastres: 140000 }),
  ]);
  assert.equal(
    scaleUp[0].rule_context_prev_24h,
    'AUTOSCALE-S | Catalogue set 1760.00 → 1936.00 at 08 Sep 07:12',
  );

  const punish = buildRows([
    budgetEvent({ time: '2026-09-08T06:13:00+0000', actor: RULE, objectId: 'B', fromPiastres: 45000, toPiastres: 40500, rule: 'CODDI AUTOSCALE-P | 2026-09 | Testing' }),
    budgetEvent({ time: '2026-09-08T07:00:00+0000', actor: OMAR, objectId: 'B', fromPiastres: 40500, toPiastres: 50000 }),
  ]);
  assert.equal(
    punish[0].rule_context_prev_24h,
    'AUTOSCALE-P | Testing set 450.00 → 405.00 at 08 Sep 09:13',
  );
});

test('rule context falls back to a single value when there is no old value', () => {
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T06:00:00+0000', actor: RULE, objectId: 'C', from: '', to: 'Inactive', rule: 'CODDI GUARD-K2 | 2026-09 | unprofitable kill' }),
    statusEvent({ time: '2026-09-08T07:00:00+0000', actor: MOHANAD, objectId: 'C', from: 'Inactive', to: 'Active' }),
  ]);
  assert.equal(
    rows[0].rule_context_prev_24h,
    'GUARD-K2 | unprofitable kill set Inactive at 08 Sep 09:00',
  );
});

test('rule context is empty when the rule fired more than 24h earlier', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-06T06:00:00+0000', actor: RULE, objectId: '888', fromPiastres: 10000, toPiastres: 9000, rule: 'CODDI AUTOSCALE-S | 2026-09 | Testing' }),
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '888', fromPiastres: 9000, toPiastres: 12000 }),
  ]);
  assert.equal(rows[0].rule_context_prev_24h, '');
});

test('rule context ignores rules on other objects and later rules', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-08T06:00:00+0000', actor: RULE, objectId: 'OTHER', fromPiastres: 1, toPiastres: 2, rule: 'CODDI AUTOSCALE-S | 2026-09 | Testing' }),
    budgetEvent({ time: '2026-09-08T09:00:00+0000', actor: RULE, objectId: '888', fromPiastres: 1, toPiastres: 2, rule: 'CODDI AUTOSCALE-S | 2026-09 | Testing' }),
    budgetEvent({ time: '2026-09-08T07:00:00+0000', actor: OMAR, objectId: '888', fromPiastres: 9000, toPiastres: 12000 }),
  ]);
  assert.equal(rows[0].rule_context_prev_24h, '');
});

test('rule context and the toggle flag appear together', () => {
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T06:00:00+0000', actor: RULE, objectId: '333', from: 'Active', to: 'Inactive', rule: 'CODDI GUARD-K2 | 2026-09 | unprofitable kill' }),
    statusEvent({ time: '2026-09-08T07:00:00+0000', actor: MOHANAD, objectId: '333', from: 'Inactive', to: 'Active' }),
    statusEvent({ time: '2026-09-08T07:10:00+0000', actor: MOHANAD, objectId: '333', from: 'Active', to: 'Inactive' }),
    statusEvent({ time: '2026-09-08T07:20:00+0000', actor: MOHANAD, objectId: '333', from: 'Inactive', to: 'Active' }),
  ]);
  assert.equal(
    rows[0].rule_context_prev_24h,
    'GUARD-K2 | unprofitable kill set Active → Inactive at 08 Sep 09:00 [toggled x3, net shown]',
  );
});

test('cleanRuleName strips the CODDI prefix and the period segment', () => {
  assert.equal(cleanRuleName('CODDI AUTOSCALE-P | 2026-09 | Testing'), 'AUTOSCALE-P | Testing');
  assert.equal(cleanRuleName('CODDI GUARD-K2 | 2026-09 | unprofitable kill'), 'GUARD-K2 | unprofitable kill');
  assert.equal(cleanRuleName('CODDI AUTOSCALE-S | 2026-09'), 'AUTOSCALE-S');
  assert.equal(cleanRuleName('Some Other Rule'), 'Some Other Rule');
});

// ---------------------------------------------------------------------------
// Sheet shape
// ---------------------------------------------------------------------------

test('rows serialise to the exact column order, with why always empty', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '120250890538420136', fromPiastres: 193600, toPiastres: 140000, name: '11/7/26 | catalogue – value – Copy 2' }),
  ]);
  const cells = toSheetRow(rows[0]);

  assert.equal(cells.length, HEADERS.length);
  assert.deepEqual(cells, [
    '20260908T1009_120250890538420136_BUD',
    '2026-09-08 10:09',
    'Omar Eissa',
    'Ad set',
    '11/7/26 | catalogue – value – Copy 2',
    '120250890538420136',
    'Budget EGP/day',
    '1936.00',
    '1400.00',
    '',
    '',
  ]);
});

test('a leading = in an object name cannot become a formula', () => {
  const rows = buildRows([
    budgetEvent({ time: '2026-09-08T07:09:00+0000', actor: OMAR, objectId: '1', fromPiastres: 100, toPiastres: 200, name: '=HYPERLINK("x")' }),
  ]);
  assert.equal(toSheetRow(rows[0])[4], `'=HYPERLINK("x")`);
});

test('rows are ordered oldest first', () => {
  const rows = buildRows([
    statusEvent({ time: '2026-09-08T10:00:00+0000', actor: OMAR, objectId: 'b', from: 'Active', to: 'Inactive' }),
    statusEvent({ time: '2026-09-08T08:00:00+0000', actor: OMAR, objectId: 'a', from: 'Active', to: 'Inactive' }),
  ]);
  assert.deepEqual(rows.map((r) => r.object_id), ['a', 'b']);
});
