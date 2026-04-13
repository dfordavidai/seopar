// api/index.js — submit URLs to Google Indexing API and Bing URL Submission API
// Requires GOOGLE_SA_JSON (service account JSON) and BING_API_KEY env vars in Vercel

import { cors, checkAuth } from '../lib/auth.js';

// ── Google Indexing API (server-side JWT signing) ───────────────────────────
async function googleIndex(url, saJson) {
  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;

  // Build JWT for service account
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }

  const sigInput = b64url(header) + '.' + b64url(claim);

  // Import RSA private key and sign
  const keyData = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');

  const binaryKey = Buffer.from(keyData, 'base64');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );
  const jwt = sigInput + '.' + Buffer.from(sig).toString('base64url');

  // Exchange JWT for access token
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10000)
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Token error: ' + JSON.stringify(tokenData));

  // Submit URL
  const indexResp = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + tokenData.access_token
    },
    body: JSON.stringify({ url, type: 'URL_UPDATED' }),
    signal: AbortSignal.timeout(10000)
  });
  const indexData = await indexResp.json();
  return { ok: indexResp.ok, status: indexResp.status, data: indexData };
}

// ── Bing URL Submission API ─────────────────────────────────────────────────
async function bingIndex(url, apiKey, siteUrl) {
  const r = await fetch(`https://ssl.bing.com/webmaster/api.svc/json/SubmitUrl?apikey=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ siteUrl, url }),
    signal: AbortSignal.timeout(10000)
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { urls = [], siteUrl = '', engines = ['google', 'bing'] } = req.body || {};
  if (!urls.length) return res.status(400).json({ error: 'urls array required' });

  const GOOGLE_SA  = process.env.GOOGLE_SA_JSON  || '';
  const BING_KEY   = process.env.BING_API_KEY    || '';

  const results = [];

  for (const url of urls.slice(0, 100)) {
    const row = { url, google: null, bing: null };

    if (engines.includes('google') && GOOGLE_SA) {
      try { row.google = await googleIndex(url, GOOGLE_SA); }
      catch (e) { row.google = { ok: false, error: e.message }; }
    } else if (engines.includes('google')) {
      row.google = { ok: false, error: 'GOOGLE_SA_JSON env var not set in Vercel' };
    }

    if (engines.includes('bing') && BING_KEY && siteUrl) {
      try { row.bing = await bingIndex(url, BING_KEY, siteUrl); }
      catch (e) { row.bing = { ok: false, error: e.message }; }
    } else if (engines.includes('bing')) {
      row.bing = { ok: false, error: 'BING_API_KEY or siteUrl missing' };
    }

    results.push(row);
    // Brief pause between submissions to avoid rate limits
    if (urls.length > 1) await new Promise(r => setTimeout(r, 200));
  }

  const googleOk = results.filter(r => r.google?.ok).length;
  const bingOk   = results.filter(r => r.bing?.ok).length;

  res.status(200).json({
    submitted: results.length,
    googleSuccess: googleOk,
    bingSuccess:   bingOk,
    results
  });
}
