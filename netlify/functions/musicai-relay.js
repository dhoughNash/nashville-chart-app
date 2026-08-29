// Save this file at: netlify/functions/musicai-relay.js
//
// This holds YOUR Music AI key server-side and relays each authenticated
// call on a subscriber's behalf, checking their subscription/trial
// eligibility along the way. The browser still drives the overall
// upload -> submit job -> poll -> fetch result flow (same logic as
// before) -- it just calls this relay instead of api.music.ai directly,
// and never sees the real key.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MUSIC_AI_API_KEY = process.env.MUSIC_AI_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action, userId } = body;
  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing userId' }) };
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
        return await handleCheckStatus(body.jobId);
      case 'get-job-result':
        return await handleGetJobResult(body.jobId);
      case 'mark-complete':
        return await handleMarkComplete(userId);
      default:
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
    }
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

async function getSubscriptionRow(userId) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=*`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!resp.ok) throw new Error(`Failed to read subscription: ${resp.status}`);
  const rows = await resp.json();
  return rows[0] || null;
}

// Checks eligibility WITHOUT consuming anything -- actual usage only gets
// recorded once the chart genuinely finishes (see handleMarkComplete),
// so a failed or abandoned attempt never costs the user their trial or a
// unit of their monthly limit.
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

async function handleCheckEligibility(userId) {
  const row = await getSubscriptionRow(userId);
  return { statusCode: 200, body: JSON.stringify(checkEligible(row)) };
}

async function handleGetUploadUrl(userId) {
  const row = await getSubscriptionRow(userId);
  const eligibility = checkEligible(row);
  if (!eligibility.eligible) {
    return { statusCode: 403, body: JSON.stringify({ error: eligibility.reason }) };
  }
  const resp = await fetch('https://api.music.ai/v1/upload', {
    headers: { Authorization: MUSIC_AI_API_KEY },
  });
  if (!resp.ok) throw new Error(`Music AI upload URL request failed: ${resp.status}`);
  const data = await resp.json();
  return { statusCode: 200, body: JSON.stringify(data) };
}

async function handleSubmitJob(userId, workflow, inputUrl, name) {
  const row = await getSubscriptionRow(userId);
  const eligibility = checkEligible(row);
  if (!eligibility.eligible) {
    return { statusCode: 403, body: JSON.stringify({ error: eligibility.reason }) };
  }
  const resp = await fetch('https://api.music.ai/v1/job', {
    method: 'POST',
    headers: { Authorization: MUSIC_AI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || 'Nashville chart', workflow, params: { inputUrl } }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Music AI job submission failed: ${resp.status} - ${text}`);
  }
  const data = await resp.json();
  return { statusCode: 200, body: JSON.stringify(data) };
}

async function handleCheckStatus(jobId) {
  const resp = await fetch(`https://api.music.ai/v1/job/${jobId}/status`, {
    headers: { Authorization: MUSIC_AI_API_KEY },
  });
  if (!resp.ok) throw new Error(`Status check failed: ${resp.status}`);
  const data = await resp.json();
  return { statusCode: 200, body: JSON.stringify(data) };
}

async function handleGetJobResult(jobId) {
  const resp = await fetch(`https://api.music.ai/v1/job/${jobId}`, {
    headers: { Authorization: MUSIC_AI_API_KEY },
  });
  if (!resp.ok) throw new Error(`Fetching job result failed: ${resp.status}`);
  const data = await resp.json();
  return { statusCode: 200, body: JSON.stringify(data) };
}

// Called by the browser once it has successfully built the full chart --
// this is the one and only place usage actually gets consumed.
async function handleMarkComplete(userId) {
  const row = await getSubscriptionRow(userId);
  if (!row) throw new Error('No subscription row found for user.');

  let patchData;
  if (row.status === 'active' && row.charts_used < row.charts_limit) {
    patchData = { charts_used: row.charts_used + 1 };
  } else if (!row.free_sample_used) {
    patchData = { free_sample_used: true };
  } else {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not eligible; nothing to mark.' }) };
  }

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patchData),
  });
  if (!resp.ok) throw new Error(`Failed to update usage: ${resp.status} ${await resp.text()}`);

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
}
