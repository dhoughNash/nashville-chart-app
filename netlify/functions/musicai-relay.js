// Save this file at: netlify/functions/musicai-relay.js
//
// This holds YOUR Music AI key server-side and relays each authenticated
// call on a subscriber's behalf. The browser still drives the overall
// upload -> submit job -> poll -> fetch result flow -- it just calls this
// relay instead of api.music.ai directly, and never sees the real key.
//
// What this relay enforces (all server-side, none of it trusts the browser):
//   1. Who is calling: the login token is verified with Supabase Auth.
//   2. App access: the caller must be on this app's guest list
//      (public.check_app_access, called with the CALLER'S token).
//   3. Spend: a unit of usage (or the one-time free trial) is reserved when
//      the chords job is submitted, atomically, so parallel requests can't
//      overspend. If Music AI reports that job FAILED, the unit is refunded
//      automatically. The sections job is a companion of one chords job.
//   4. Workflows: only the two known workflow slugs can be run.
//   5. Ownership: every job is recorded against the user who created it in
//      chart_book.jobs, and status/result calls only work for your own jobs.
//
// The subscriptions and jobs tables live in their own schema (chart_book),
// so every service-role database call below names that schema explicitly.
// The guest-list RPC lives in the public schema and must NOT name it.
//
// Required Netlify env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY, MUSIC_AI_API_KEY. SUPABASE_ANON_KEY is public (it's in
// index.html), so add it to SECRETS_SCAN_OMIT_KEYS like SUPABASE_URL.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MUSIC_AI_API_KEY = process.env.MUSIC_AI_API_KEY;

const APP_KEY = 'charting';
const DB_SCHEMA = 'chart_book';

// These must match CHORDS_WORKFLOW_SLUG / SECTIONS_WORKFLOW_SLUG in
// index.html. If you ever change a slug there, change it here too.
const CHORDS_WORKFLOW = 'untitled-workflow-40fd1d9';
const SECTIONS_WORKFLOW = 'untitled-workflow-40fe1ea';

// A sections job must follow a chords job from this user within this window.
const SECTIONS_WINDOW_MS = 2 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

const reply = (statusCode, obj) => ({ statusCode, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return reply(400, { error: 'Invalid JSON body' });
  }

  const { action } = body;

  // Who is calling? Not whatever the request body claims -- Supabase
  // tells us, from the caller's login token. Every action requires this,
  // including the ones that only check job status.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return reply(401, { error: 'Not logged in. Please refresh the page and log in again.' });
  }
  const userId = await verifyUserFromToken(token);
  if (!userId) {
    return reply(401, { error: 'Your login is no longer valid. Please refresh the page and log in again.' });
  }

  // Are they on this app's guest list? Checked before any action, and it
  // fails closed: if we can't tell, nothing runs.
  let hasAccess;
  try {
    hasAccess = await checkAppAccess(token);
  } catch (e) {
    console.error('App access lookup failed', e);
    return reply(503, { error: 'Could not verify app access right now. Please try again in a moment.' });
  }
  if (!hasAccess) {
    return reply(403, { error: 'This account does not have access to this app yet. Please refresh the page and log in again.' });
  }

  try {
    switch (action) {
      case 'check-eligibility':
        return await handleCheckEligibility(userId);
      case 'get-upload-url':
        return await handleGetUploadUrl(userId);
      case 'submit-job':
        return await handleSubmitJob(userId, body.workflow, body.inputUrl, body.name);
      case 'check-status':
        return await handleCheckStatus(userId, body.jobId);
      case 'get-job-result':
        return await handleGetJobResult(userId, body.jobId);
      case 'mark-complete':
        return handleMarkComplete();
      default:
        return reply(400, { error: 'Unknown action' });
    }
  } catch (err) {
    console.error(err);
    return reply(500, { error: err.message });
  }
};

// ---------------------------------------------------------------------------
// Auth and guest list
// ---------------------------------------------------------------------------

// Asks Supabase Auth who a login token belongs to. Returns the user's id,
// or null if the token is missing, expired, or fake.
async function verifyUserFromToken(token) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
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

// Calls public.check_app_access with the CALLER'S token (the service role
// has no logged-in user, so it would always come back false). No
// Content-Profile header: this function is in the public schema.
// Returns true/false; throws if the lookup itself fails.
async function checkAppAccess(token) {
  if (!SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_ANON_KEY is not set on the server.');
  }
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_app_access`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_app: APP_KEY }),
  });
  if (!resp.ok) {
    throw new Error(`check_app_access failed: ${resp.status} ${await resp.text()}`);
  }
  const result = await resp.json();
  if (typeof result !== 'boolean') {
    throw new Error('check_app_access returned an unexpected value.');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Database helpers (service role, chart_book schema)
// ---------------------------------------------------------------------------

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

// PATCH that returns the rows it changed, so callers can tell whether their
// filter actually matched (used for atomic claim-or-fail updates).
function patchReturning(path, body) {
  return db('PATCH', path, { body, prefer: 'return=representation' });
}

async function fetchSubscriptionRow(userId) {
  const rows = await db('GET', `subscriptions?user_id=eq.${userId}&select=*`);
  return rows[0] || null;
}

// Returns the user's subscription row, creating a blank one (status
// 'inactive', table defaults for everything else) if they don't have one
// yet. Safe to call repeatedly: ignore-duplicates means a second attempt,
// or two requests racing each other, can never overwrite an existing row.
// user_id is the primary key, so there is only ever one row (and one free
// trial) per user.
async function getSubscriptionRow(userId) {
  const existing = await fetchSubscriptionRow(userId);
  if (existing) return existing;

  try {
    await db('POST', 'subscriptions?on_conflict=user_id', {
      body: { user_id: userId, status: 'inactive' },
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
  } catch (e) {
    // Most likely cause: this user id doesn't exist in auth.users.
    console.error('Failed to create subscription row', e);
    throw new Error('Could not set up a subscription record for this user.');
  }
  return await fetchSubscriptionRow(userId);
}

// Checks eligibility WITHOUT consuming anything.
function checkEligible(row) {
  if (!row) return { eligible: false, reason: 'No subscription record found. Please log in again.' };
  if (row.status === 'active' && row.charts_used < row.charts_limit) {
    return { eligible: true, mode: 'subscription' };
  }
  if (!row.free_sample_used) {
    return { eligible: true, mode: 'trial' };
  }
  return { eligible: false, reason: 'Free trial already used, and no active subscription. Please subscribe to continue.' };
}

// Reserves one unit of usage (a subscription chart, or the one free trial)
// atomically. The update only applies if the row still looks exactly the way
// we just read it, so two requests racing each other can't both spend the
// last unit. Retries a few times if someone else changed the row first.
async function reserveUnit(userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getSubscriptionRow(userId);
    const eligibility = checkEligible(row);
    if (!eligibility.eligible) return { ok: false, reason: eligibility.reason };

    let changed;
    if (eligibility.mode === 'subscription') {
      changed = await patchReturning(
        `subscriptions?user_id=eq.${userId}&status=eq.active&charts_used=eq.${row.charts_used}`,
        { charts_used: row.charts_used + 1 }
      );
    } else {
      changed = await patchReturning(
        `subscriptions?user_id=eq.${userId}&free_sample_used=eq.false`,
        { free_sample_used: true }
      );
    }
    if (changed.length === 1) return { ok: true, mode: eligibility.mode };
  }
  return { ok: false, reason: 'Your account was busy. Please try again.' };
}

// Gives a reserved unit back (job failed, or we couldn't record it).
async function releaseUnit(userId, mode) {
  if (mode === 'trial') {
    await patchReturning(
      `subscriptions?user_id=eq.${userId}&free_sample_used=eq.true`,
      { free_sample_used: false }
    );
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await fetchSubscriptionRow(userId);
    if (!row || !(row.charts_used > 0)) return;
    const changed = await patchReturning(
      `subscriptions?user_id=eq.${userId}&charts_used=eq.${row.charts_used}`,
      { charts_used: row.charts_used - 1 }
    );
    if (changed.length === 1) return;
  }
  console.error(`Could not refund a unit for user ${userId} after 3 attempts.`);
}

// Records who owns a job. kind is 'chords' (the one that costs a unit) or
// 'sections' (a companion of one chords job).
function insertJob(jobId, userId, kind, mode) {
  return db('POST', 'jobs', {
    body: { job_id: jobId, user_id: userId, kind, mode },
    prefer: 'return=minimal',
  });
}

// Returns the job row only if it belongs to this user.
async function getOwnedJob(userId, jobId) {
  if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return null;
  const rows = await db('GET', `jobs?job_id=eq.${jobId}&user_id=eq.${userId}&select=*`);
  return rows[0] || null;
}

// The user's most recent chords job that is still waiting for its sections
// companion (not failed, not already used, recent enough).
async function findOpenChordsJob(userId) {
  const since = encodeURIComponent(new Date(Date.now() - SECTIONS_WINDOW_MS).toISOString());
  const rows = await db(
    'GET',
    `jobs?user_id=eq.${userId}&kind=eq.chords&state=eq.active&sections_used=eq.false` +
      `&created_at=gte.${since}&order=created_at.desc&limit=1&select=*`
  );
  return rows[0] || null;
}

// Marks a job failed (once). If it was a chords job, gives the unit back.
// The state change is the guard: only the call that flips active -> failed
// refunds, so polling a failed job repeatedly can't refund twice.
async function settleFailedJob(job) {
  const flipped = await patchReturning(
    `jobs?job_id=eq.${job.job_id}&state=eq.active`,
    { state: 'failed' }
  );
  if (flipped.length === 1 && job.kind === 'chords') {
    await releaseUnit(job.user_id, job.mode);
  }
}

// ---------------------------------------------------------------------------
// Music AI helpers
// ---------------------------------------------------------------------------

async function createMusicAiJob(workflow, inputUrl, name) {
  const resp = await fetch('https://api.music.ai/v1/job', {
    method: 'POST',
    headers: { Authorization: MUSIC_AI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, workflow, params: { inputUrl } }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Music AI job submission failed: ${resp.status} - ${text}`);
  }
  return await resp.json();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function handleCheckEligibility(userId) {
  const row = await getSubscriptionRow(userId);
  return reply(200, checkEligible(row));
}

async function handleGetUploadUrl(userId) {
  // A new chart needs an eligible account. The second upload of a chart (for
  // the sections job) happens after its unit was already reserved, so it is
  // also allowed while that chart's sections job is still pending.
  const row = await getSubscriptionRow(userId);
  const eligibility = checkEligible(row);
  if (!eligibility.eligible) {
    const pending = await findOpenChordsJob(userId);
    if (!pending) return reply(403, { error: eligibility.reason });
  }
  const resp = await fetch('https://api.music.ai/v1/upload', {
    headers: { Authorization: MUSIC_AI_API_KEY },
  });
  if (!resp.ok) throw new Error(`Music AI upload URL request failed: ${resp.status}`);
  return reply(200, await resp.json());
}

async function handleSubmitJob(userId, workflow, inputUrl, name) {
  if (workflow !== CHORDS_WORKFLOW && workflow !== SECTIONS_WORKFLOW) {
    return reply(400, { error: 'Unknown workflow.' });
  }
  if (typeof inputUrl !== 'string' || !inputUrl.startsWith('https://')) {
    return reply(400, { error: 'Invalid input URL.' });
  }
  const jobName = (typeof name === 'string' && name.trim() ? name.trim() : 'Nashville chart').slice(0, 100);

  if (workflow === CHORDS_WORKFLOW) {
    // This is the job that costs a unit. Reserve first, refund if anything
    // goes wrong before we have a recorded job.
    const reservation = await reserveUnit(userId);
    if (!reservation.ok) return reply(403, { error: reservation.reason });

    let job;
    try {
      job = await createMusicAiJob(workflow, inputUrl, jobName);
    } catch (err) {
      await releaseUnit(userId, reservation.mode).catch((e) => console.error('Refund failed', e));
      throw err;
    }
    try {
      await insertJob(job.id, userId, 'chords', reservation.mode);
    } catch (err) {
      console.error(`Job ${job.id} was created for user ${userId} but could not be recorded`, err);
      await releaseUnit(userId, reservation.mode).catch((e) => console.error('Refund failed', e));
      throw new Error('Could not record this job. Please try again.');
    }
    return reply(200, job);
  }

  // Sections job: a companion of this user's most recent chords job, one per
  // chords job. It costs no extra unit, but it can't be run on its own.
  const parent = await findOpenChordsJob(userId);
  if (!parent) {
    return reply(403, { error: 'No active chart to attach this job to.' });
  }
  const claimed = await patchReturning(
    `jobs?job_id=eq.${parent.job_id}&sections_used=eq.false`,
    { sections_used: true }
  );
  if (claimed.length !== 1) {
    return reply(409, { error: 'This chart already has its sections job.' });
  }
  const unclaim = () =>
    patchReturning(`jobs?job_id=eq.${parent.job_id}`, { sections_used: false })
      .catch((e) => console.error('Could not release sections claim', e));

  let job;
  try {
    job = await createMusicAiJob(workflow, inputUrl, jobName);
  } catch (err) {
    await unclaim();
    throw err;
  }
  try {
    await insertJob(job.id, userId, 'sections', parent.mode);
  } catch (err) {
    console.error(`Sections job ${job.id} was created for user ${userId} but could not be recorded`, err);
    await unclaim();
    throw new Error('Could not record this job. Please try again.');
  }
  return reply(200, job);
}

async function handleCheckStatus(userId, jobId) {
  const job = await getOwnedJob(userId, jobId);
  if (!job) return reply(404, { error: 'Job not found.' });

  const resp = await fetch(`https://api.music.ai/v1/job/${job.job_id}/status`, {
    headers: { Authorization: MUSIC_AI_API_KEY },
  });
  if (!resp.ok) throw new Error(`Status check failed: ${resp.status}`);
  const data = await resp.json();

  if (String(data.status || '').toUpperCase() === 'FAILED') {
    try {
      await settleFailedJob(job);
    } catch (e) {
      console.error(`Could not settle failed job ${job.job_id}`, e);
    }
  }
  return reply(200, data);
}

async function handleGetJobResult(userId, jobId) {
  const job = await getOwnedJob(userId, jobId);
  if (!job) return reply(404, { error: 'Job not found.' });

  const resp = await fetch(`https://api.music.ai/v1/job/${job.job_id}`, {
    headers: { Authorization: MUSIC_AI_API_KEY },
  });
  if (!resp.ok) throw new Error(`Fetching job result failed: ${resp.status}`);
  return reply(200, await resp.json());
}

// The browser still calls this once a chart is fully built, but usage is now
// reserved when the chords job is submitted (see handleSubmitJob), so there
// is nothing left to consume here. Kept so the existing page keeps working
// without changes.
function handleMarkComplete() {
  return reply(200, { success: true });
}
