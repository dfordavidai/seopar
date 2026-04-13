// api/ping.js — ping search engines + RSS aggregators to notify of new content
// Used by the SEO tool after publishing parasite posts

import { cors, checkAuth } from '../lib/auth.js';

const PING_ENDPOINTS = [
  // Google
  { name: 'Google Ping',        url: 'https://www.google.com/ping',        param: 'sitemap' },
  // Bing
  { name: 'Bing Ping',          url: 'https://www.bing.com/ping',           param: 'sitemap' },
  // Classic blog ping services (XML-RPC style via GET)
  { name: 'Ping-o-Matic',       url: 'https://rpc.pingomatic.com/RPC2',     param: null, rpc: true },
  { name: 'BlogPing',           url: 'https://www.blogping.com/ping.php',   param: 'blogUrl' },
  { name: 'PingMyBlog',         url: 'http://www.pingmyblog.com/api/ping',  param: 'url' },
  { name: 'TotalPing',          url: 'https://www.totalping.com/ping.php',  param: 'url' },
  { name: 'Feedshark',          url: 'https://feedshark.brainbliss.com/',   param: 'url' },
];

function buildXmlRpc(blogName, blogUrl, rssUrl) {
  return `<?xml version="1.0"?><methodCall><methodName>weblogUpdates.extendedPing</methodName><params><param><value>${blogName}</value></param><param><value>${blogUrl}</value></param><param><value>${rssUrl}</value></param></params></methodCall>`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;

  const { url, sitemap, name = 'New Post', services } = req.method === 'POST'
    ? (req.body || {})
    : req.query;

  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const targetServices = services
    ? PING_ENDPOINTS.filter(p => services.includes(p.name))
    : PING_ENDPOINTS;

  const results = [];

  await Promise.allSettled(targetServices.map(async (svc) => {
    const start = Date.now();
    try {
      let pingUrl = '';
      let opts = { method: 'GET' };

      if (svc.rpc) {
        // XML-RPC POST ping
        const body = buildXmlRpc(name, url, sitemap || url + '/feed');
        opts = { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body };
        pingUrl = svc.url;
      } else if (svc.param) {
        const u = new URL(svc.url);
        u.searchParams.set(svc.param, sitemap || url);
        pingUrl = u.toString();
      } else {
        pingUrl = svc.url;
      }

      const r = await fetch(pingUrl, { ...opts, signal: AbortSignal.timeout(8000) });
      results.push({ service: svc.name, status: r.status, ok: r.ok, ms: Date.now() - start });
    } catch (e) {
      results.push({ service: svc.name, status: 0, ok: false, error: e.message, ms: Date.now() - start });
    }
  }));

  const ok = results.filter(r => r.ok).length;
  res.status(200).json({
    pinged: results.length,
    success: ok,
    failed: results.length - ok,
    url,
    sitemap: sitemap || null,
    results
  });
}
