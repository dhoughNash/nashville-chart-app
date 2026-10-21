// Save this file at: netlify/functions/google-drive-token.js
//
// Keeps a user's Google Drive connection alive without the hourly re-login.
//
// How it works:
//   - The browser does Google's popup sign-in once and hands us a one-time
//     "code" (action: exchange). We trade it, using the client secret that
//     only this server knows, for an access token (1 hour) AND a refresh
//     token (long-lived). The refresh token is stored in Supabase and never
//     goes back to the browser.
//   - Whenever the browser needs a fresh 1-hour access token, it calls
//     action: refresh and we mint one from the stored refresh token.
//   - action: disconnect revokes the grant at Google and deletes the row.
//
// Every call requires the caller's Supabase login token (same pattern as
// musicai-relay.js), and the refresh token is stored per-user in
// chart_book.google_tokens, which only the service role can read.
//
// Required Netlify env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// GOOGLE_CLIENT_SECRET.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Public value (it's in index.html too). Hardcoded so Netlify's secret
// scanner doesn't flag it.
const GOOGLE_CLIENT_ID = '451996104682-kj3dmo065dt1e4jh8to95j3etj473g6q.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

const DB_SCHEMA = 'chart_book';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!GOOGLE_CLIENT_SECRET) {
    console.error('GOOGLE_CLIENT_SECRET is not set.');
    return reply(500, { error: 'Google Drive sync is not configured on the server yet.' });
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return reply(400, { error: 'Invalid JSON body' }); }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return reply(401, { error: 'Not logged in. Please refresh the page and log in again.' });
  const userId = await verifyUserFromToken(token);
  if (!userId) return reply(401, { error: 'Your login is no longer valid. Please refresh the page and log in again.' });

  try {
    switch (body.action) {
      case 'exchange': return await handleExchange(userId, body.code);
      case 'refresh': return await handleRefresh(userId);
      case 'disconnect': return await handleDisconnect(userId);
      default: return reply(400, { error: 'Unknown action' });
    }
  } catch (err) {
    console.error(err);
    return reply(500, { error: 'Something went wrong. Please try again in a moment.' });
  }
};

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function verifyUserFromToken(token) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const user = await resp.json();
    if (!user || typeof user.id !== 'string' || !UUID_RE.test(user.id)) return null;
    return user.id;
  } catch (e) {
    console.error('Token verification failed', e);
    return null;
  }
}

async function db(method, path, { body, prefer } = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };
  if (method === 'GET') headers['Accept-Profile'] = DB_SCHEMA;
  else headers['Content-Profile'] = DB_SCHEMA;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`Database ${method} ${path.split('?')[0]} failed: ${resp.status} ${await resp.text()}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function getRow(userId) {
  const rows = await db('GET', `google_tokens?user_id=eq.${userId}&select=refresh_token`);
  return rows[0] || null;
}

function saveRefreshToken(userId, refreshToken) {
  return db('POST', 'google_tokens?on_conflict=user_id', {
    body: { user_id: userId, refresh_token: refreshToken, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

function deleteRow(userId) {
  return db('DELETE', `google_tokens?user_id=eq.${userId}`, { prefer: 'return=minimal' });
}

// ---------------------------------------------------------------------------
// Google helpers
// ---------------------------------------------------------------------------

async function googleTokenRequest(params) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  let data = {};
  try { data = await resp.json(); } catch (e) {}
  return { ok: resp.ok, status: resp.status, data };
}

async function googleRevoke(token) {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch (e) {
    console.error('Google revoke failed', e);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleExchange(userId, code) {
  if (typeof code !== 'string' || !code) return reply(400, { error: 'Missing sign-in code.' });

  // 'postmessage' is the redirect value Google requires for codes issued by
  // the popup sign-in button (no redirect URI to register).
  const result = await googleTokenRequest({
    code,
    grant_type: 'authorization_code',
    redirect_uri: 'postmessage',
  });
  if (!result.ok || !result.data.access_token) {
    console.error('Google code exchange failed', result.status, result.data);
    return reply(400, { error: 'Google rejected the sign-in. Please try again.', code: 'exchange_failed' });
  }
  const tok = result.data;

  if (!String(tok.scope || '').includes(DRIVE_SCOPE)) {
    await googleRevoke(tok.access_token);
    return reply(400, { error: 'Drive access was not granted.', code: 'scope_missing' });
  }

  if (tok.refresh_token) {
    await saveRefreshToken(userId, tok.refresh_token);
  } else {
    // Google only issues a refresh token the first time a person grants
    // access. If we already hold one for this user (e.g. they connected on
    // another device), keep it. If we don't, revoke this grant so the next
    // click shows the consent screen again and returns a refresh token.
    const existing = await getRow(userId);
    if (!existing) {
      await googleRevoke(tok.access_token);
      return reply(409, {
        error: 'Almost there -- please click Connect Google Drive once more to finish.',
        code: 'retry_connect',
      });
    }
  }

  return reply(200, { access_token: tok.access_token, expires_in: tok.expires_in || 3600 });
}

async function handleRefresh(userId) {
  const row = await getRow(userId);
  if (!row) return reply(404, { error: 'Google Drive is not connected.', code: 'not_connected' });

  const result = await googleTokenRequest({
    refresh_token: row.refresh_token,
    grant_type: 'refresh_token',
  });

  if (!result.ok || !result.data.access_token) {
    if (result.data && result.data.error === 'invalid_grant') {
      // Revoked, expired, or otherwise dead -- the person has to reconnect.
      await deleteRow(userId);
      return reply(401, { error: 'Google Drive access ended. Please reconnect.', code: 'reconnect_required' });
    }
    console.error('Google refresh failed', result.status, result.data);
    return reply(502, { error: 'Could not reach Google just now. Please try again.', code: 'google_unavailable' });
  }

  return reply(200, { access_token: result.data.access_token, expires_in: result.data.expires_in || 3600 });
}

async function handleDisconnect(userId) {
  const row = await getRow(userId);
  if (row) {
    await googleRevoke(row.refresh_token);
    await deleteRow(userId);
  }
  return reply(200, { success: true });
}
