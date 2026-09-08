/**
 * Google Sheets v4 client.
 *
 * Service-account auth is done by hand (signed JWT -> OAuth token) because
 * googleapis does not run on the Workers runtime.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const TAB = 'change_log';

export class SheetsError extends Error {}

// --- JWT signing -----------------------------------------------------------

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlJson(value) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** PEM -> raw PKCS#8 bytes. */
function pemToBytes(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Mint a short-lived OAuth access token for the service account. */
export async function getAccessToken(env) {
  let sa;
  try {
    sa = JSON.parse(env.GOOGLE_SA_KEY);
  } catch {
    throw new SheetsError('GOOGLE_SA_KEY is not valid JSON');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new SheetsError('GOOGLE_SA_KEY is missing client_email or private_key');
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64urlJson({ alg: 'RS256', typ: 'JWT' })}.${base64urlJson(claims)}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(signature))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new SheetsError(`Google token ${res.status}: ${body.slice(0, 500)}`);
  }
  const token = JSON.parse(body).access_token;
  if (!token) throw new SheetsError('Google token response had no access_token');
  return token;
}

// --- Sheets ----------------------------------------------------------------

async function sheetsFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new SheetsError(`Sheets ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) : {};
}

/**
 * Read column A. This is the authoritative dedupe source — the KV cursor is
 * only there to keep the Meta window small.
 */
export async function readChangeIds(env, token) {
  const range = encodeURIComponent(`${TAB}!A:A`);
  const json = await sheetsFetch(
    `${SHEETS_BASE}/${env.SHEET_ID}/values/${range}?majorDimension=COLUMNS`,
    token,
  );
  const column = json.values?.[0] ?? [];
  const ids = new Set(column.map((v) => String(v).trim()).filter(Boolean));
  return { ids, rowCount: column.length, hasHeader: column[0] === 'change_id' };
}

/** The numeric id (gid) of the change_log tab, needed for formatting calls. */
async function getTabId(env, token) {
  const json = await sheetsFetch(
    `${SHEETS_BASE}/${env.SHEET_ID}?fields=sheets.properties(sheetId,title)`,
    token,
  );
  const tab = json.sheets?.find((s) => s.properties?.title === TAB);
  if (!tab) {
    const found = (json.sheets ?? []).map((s) => s.properties?.title).join(', ');
    throw new SheetsError(`No tab named "${TAB}" (found: ${found || 'none'})`);
  }
  return tab.properties.sheetId;
}

/**
 * Column display formats, applied once.
 *
 * Values are written with valueInputOption=USER_ENTERED so that dates sort as
 * dates and budgets sort as numbers rather than as text. The cost is that
 * Sheets renders "1936.00" as "1936" and "09:54" as "9:54" under the default
 * format, so the columns are given explicit patterns. This is display only —
 * the stored values are already correct.
 */
export async function applyColumnFormats(env, token) {
  const sheetId = await getTabId(env, token);

  const numberFormat = (startColumnIndex, endColumnIndex, pattern, type) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex, endColumnIndex },
      cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });

  const requests = [
    // B: datetime
    numberFormat(1, 2, 'yyyy-mm-dd hh:mm', 'DATE_TIME'),
    // H and I: from / to. Status rows hold text here, which a number format
    // leaves untouched.
    numberFormat(7, 9, '0.00', 'NUMBER'),
    // Keep the header visible while scrolling a long log.
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
  ];

  await sheetsFetch(`${SHEETS_BASE}/${env.SHEET_ID}:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

/**
 * Append rows in a single call, so a failure can never leave the sheet with a
 * partial batch.
 */
export async function appendRows(env, token, values) {
  if (values.length === 0) return { updates: { updatedRows: 0 } };
  const range = encodeURIComponent(`${TAB}!A1`);
  const params = new URLSearchParams({
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
  });
  return sheetsFetch(
    `${SHEETS_BASE}/${env.SHEET_ID}/values/${range}:append?${params}`,
    token,
    { method: 'POST', body: JSON.stringify({ values }) },
  );
}
