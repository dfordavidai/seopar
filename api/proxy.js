// api/proxy.js — universal CORS proxy for SEO Parasite Pro
// Handles GET (page fetch) and POST (form/REST comment submission)
// Always returns a JSON envelope: { ok, status_code, body, redirected, redirect_url }
// This lets the frontend reliably read the REAL upstream status regardless of proxy wrapping.

import { cors, checkAuth } from '../lib/auth.js';

const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '169.254.', '10.', '192.168.', '172.16.'
];
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 25000;
const MAX_REDIRECTS = 5;

function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return !BLOCKED_HOSTS.some(b => host === b || host.startsWith(b));
  } catch { return false; }
}

// Manual redirect follower so we can detect + report redirects to the frontend.
// wp-comments-post.php succeeds via 302 redirect — we must catch that signal.
async function fetchFollowingRedirects(url, opts, maxRedirects) {
  let currentUrl = url;
  let redirected = false;
  let finalUrl = url;
  let hops = 0;
  let currentOpts = { ...opts };

  while (hops <= maxRedirects) {
    const resp = await fetch(currentUrl, { ...currentOpts, redirect: 'manual' });

    if (resp.status < 300 || resp.status >= 400) {
      return { resp, redirected, finalUrl };
    }

    const location = resp.headers.get('location');
    if (!location) return { resp, redirected, finalUrl };

    redirected = true;
    finalUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;

    // POST -> GET after 301/302/303 (standard browser behaviour)
    if ([301, 302, 303].includes(resp.status) && currentOpts.method === 'POST') {
      const { body, ...rest } = currentOpts;
      const newHeaders = { ...rest.headers };
      delete newHeaders['Content-Type'];
      delete newHeaders['content-type'];
      currentOpts = { ...rest, method: 'GET', headers: newHeaders };
    }

    currentUrl = finalUrl;
    hops++;
  }

  // Too many redirects — fetch final URL directly
  const resp = await fetch(currentUrl, { ...currentOpts, redirect: 'follow' });
  return { resp, redirected: true, finalUrl: currentUrl };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;

  let targetUrl = '';
  let method = 'GET';
  let bodyToSend = undefined;
  let extraHeaders = {};
  let timeout = DEFAULT_TIMEOUT;

  if (req.method === 'POST') {
    const b = req.body || {};
    targetUrl    = b.url    || '';
    method       = (b.method || 'GET').toUpperCase();
    bodyToSend   = b.body   ?? undefined;
    extraHeaders = b.headers || {};
    // Accept timeout in seconds OR milliseconds
    const rawTimeout = parseInt(b.timeout) || 0;
    timeout = rawTimeout > 0 ? (rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout) : DEFAULT_TIMEOUT;
  } else {
    targetUrl = req.query.url || '';
    method    = (req.query.method || 'GET').toUpperCase();
    timeout   = parseInt(req.query.timeout) || DEFAULT_TIMEOUT;
  }

  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });
  if (!isSafeUrl(targetUrl)) return res.status(400).json({ error: 'Invalid or unsafe URL' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout + 3000);

  try {
    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control':   'no-cache',
      ...extraHeaders,  // frontend headers win (Referer, Content-Type, Origin, etc.)
    };

    const fetchOpts = { method, signal: controller.signal, headers };

    if (bodyToSend !== undefined && ['POST', 'PUT', 'PATCH'].includes(method)) {
      if (typeof bodyToSend === 'string') {
        // URL-encoded string (legacy wp-comments-post.php)
        fetchOpts.body = bodyToSend;
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else {
        // Object (WP REST API JSON payload)
        fetchOpts.body = JSON.stringify(bodyToSend);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const { resp: upstream, redirected, finalUrl } = await fetchFollowingRedirects(
      targetUrl, fetchOpts, MAX_REDIRECTS
    );
    clearTimeout(timer);

    if (!upstream) {
      return res.status(200).json({
        ok: false, status_code: 502, error: 'No response from upstream',
        body: '', text: '', redirected: false, redirect_url: targetUrl, url: targetUrl
      });
    }

    const contentType = upstream.headers.get('content-type') || 'text/plain';
    const buffer = await upstream.arrayBuffer();
    const bytes = Buffer.from(buffer).slice(0, MAX_BODY_BYTES);
    const isText = /text|json|xml|javascript|html/i.test(contentType);
    const bodyText = isText ? bytes.toString('utf8') : bytes.toString('base64');

    // Always 200 on the outer envelope — real status is inside status_code
    return res.status(200).json({
      ok:           upstream.status >= 200 && upstream.status < 400,
      status_code:  upstream.status,
      redirected,
      redirect_url: finalUrl,
      body:         bodyText,
      text:         bodyText,   // alias
      content_type: contentType,
      url:          targetUrl,
    });

  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return res.status(200).json({
      ok:          false,
      status_code: isTimeout ? 504 : 502,
      error:       isTimeout ? 'Request timed out' : err.message,
      url:         targetUrl,
      body:        '',
      text:        '',
      redirected:  false,
      redirect_url: targetUrl,
    });
  }
}
