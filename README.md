# coddi-changelog

Cloudflare Worker that appends **manual** Meta ad account changes to a Google
Sheet. Runs on a cron every 15 minutes.

- Ad account: `act_904315886897104` (Coddiwomple, EGP, Africa/Cairo)
- Sheet tab: `change_log`
- Only changes made by Mohanad Ashraf or Omar Eissa become rows. Automated rule
  actions and Meta system events are excluded from the rows, but are used to
  fill the `rule_context_prev_24h` column.

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create CHANGELOG_KV
```

Copy the printed `id` into `wrangler.toml`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

> On wrangler v3 before 3.60, the command is `wrangler kv:namespace create CHANGELOG_KV`.

### 3. Set the three secrets

```bash
npx wrangler secret put META_TOKEN
npx wrangler secret put SHEET_ID
```

Each prompts for a single line — paste the value and press Enter.

`GOOGLE_SA_KEY` is multi-line JSON, so pipe the file in rather than pasting:

```bash
# PowerShell
Get-Content .\sa-key.json -Raw | npx wrangler secret put GOOGLE_SA_KEY

# bash
npx wrangler secret put GOOGLE_SA_KEY < sa-key.json
```

Then delete `sa-key.json`. It is gitignored, but there is no reason to keep it
on disk.

Share the sheet with `meta-ads-sheets-logger@coddi-dashboard-sync.iam.gserviceaccount.com`
as **Editor**, and make sure the tab is named exactly `change_log`.

### 4. Deploy

```bash
npm test          # must pass first
npx wrangler deploy
```

The cron trigger in `wrangler.toml` starts on deploy.

## Local development

Put the same values in `.dev.vars` (gitignored):

```
META_TOKEN=...
SHEET_ID=...
GOOGLE_SA_KEY={"type":"service_account",...}
RUN_TOKEN=some-long-random-string
```

Then `npx wrangler dev` and hit `http://localhost:8787/dry-run?token=...`.

## Manual trigger

Both endpoints require the optional `RUN_TOKEN` secret. If it is not set, they
return 403 and only the cron runs.

| Endpoint | Effect |
|---|---|
| `GET /health` | Liveness check, no auth. |
| `GET /dry-run?token=...` | Fetches and transforms, returns the rows as JSON. **Writes nothing.** |
| `GET /run?token=...` | A full cycle, same as the cron. |

Use `/dry-run` for the first run to eyeball the rows before anything reaches the
sheet.

## Columns

`change_id | datetime | actor | level | object_name | object_id | event | from | to | rule_context_prev_24h | why`

- `change_id` — `<YYYYMMDDTHHMM>_<object_id>_<BUD|STA|CRE>`, the dedupe key.
- `datetime` — `YYYY-MM-DD HH:MM`, Africa/Cairo (DST-aware; Egypt observes DST again).
- `from` / `to` — budgets are divided by 100 (the API reports piastres) and
  formatted to two decimals. Statuses are passed through as strings.
- `rule_context_prev_24h` — the most recent automated-rule change to the *same*
  object in the 24h before the row, as
  `<rule name> set <from> → <to> at <DD Mon HH:MM>`. Both ends are shown so a
  scale-up is distinguishable from a cut or a kill. Empty when no rule touched
  that object. The `[toggled xN, net shown]` and `[no net change]` flags share
  this column.
- `why` — always written empty. Humans fill it in. The worker only ever appends
  new rows and never rewrites an existing one, so a filled-in `why` cannot be
  clobbered.

## Column formats

Values are written with `valueInputOption=USER_ENTERED` so dates sort as dates
and budgets sort as numbers. The side effect is that Sheets renders `1936.00` as
`1936` under the default format, so the worker applies explicit patterns
(`yyyy-mm-dd hh:mm` on B, `0.00` on H:I) plus a frozen bold header row. This runs
once, guarded by the `sheet_format_version` KV key; bump `FORMAT_VERSION` in
`src/index.js` to re-apply. It is display-only — the stored values are correct
either way — so a formatting failure is logged and the run continues.

## Behaviour worth knowing

**Actor ids are app-scoped.** The same person has a different `actor_id`
depending on which app's token reads the log. Through this worker's system-user
token, Mohanad is `122158908416988713` and Omar is `10175294362345133`; through
other Meta surfaces they appear as `61579661412455` and `740265132`. All four ids
are accepted, and there is a fallback match on `actor_name`, so rotating the
token or the app degrades to "still logs the right people" instead of to a
silently empty sheet.

**Event types are matched on Meta's snake_case codes**, not the English labels.
The Graph API returns `event_type: "update_ad_set_budget"` with the label in
`translated_event_type`, and the label's capitalisation is not stable — the
ad-review duplicate comes back as "…finishes ad review" from the Graph API but
"…finishes Ad Review" elsewhere. Codes are authoritative; the label is a
fallback for codes not yet in the map.

**Collapsing.** Raw events are grouped by (`object_id`, category, Cairo calendar
date) and emitted as one row: `from` is the first non-"Pending Process" old
value, `to` is the last non-"Pending Process" new value, `datetime` is the
earliest event in the group. More than 2 events in a group appends
`[toggled xN, net shown]` to `rule_context_prev_24h`. If `from == to` the row is
still emitted, flagged `[no net change]` — never silently dropped.

The canonical status edit is 2 events after the ad-review duplicate is dropped
(Active → Pending Process → Inactive), which is why the toggle threshold is >2.

If a group's only old value *is* "Pending Process" — which happens when the
paired event falls outside the fetch window — that literal value is shown rather
than guessing at the state before it.

**Idempotency.** Column A is read before every append and matching `change_id`s
are skipped; that check is authoritative. The KV cursor (`last_run_unix`) only
keeps the Meta fetch window small, and is deliberately rewound an hour on each
run for overlap.

**Failure.** Any Meta or Sheets error throws: nothing is appended, the KV cursor
is not advanced, and the run reports non-200 so the failure is visible. The
append is a single API call, so a batch can never land half-written.

## Tests

```bash
npm test
```

Covers status collapsing (the Active/Pending/Inactive sequence and the
off/on/off toggle), piastre division, `change_id` determinism including DST,
dedupe skipping, actor filtering, and rule-context formatting. No network, no
credentials.
