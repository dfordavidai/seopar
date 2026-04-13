// api/headers.js — fetch HTTP response headers for any URL (server-side, no CORS issues)
// Used by rank tracker, backlink monitor, and site auditor modules

import { cors, checkAuth } from '../lib/auth.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;

  const url = (req.method === 'POST' ? req.body?.url : req.query?.url) || '';
  if (!url) return res.status(400).json({ error: 'Missing url' });

  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOBot/1.0)',
      }
    });

    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });

    res.status(200).json({
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      url: r.url,           // final URL after redirects
      redirected: r.redirected,
      headers,
      checked: new Date().toISOString()
    });
  } catch (e) {
    res.status(200).json({ ok: false, status: 0, error: e.message, url });
  }
}
