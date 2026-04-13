// api/health.js — connectivity test endpoint
import { cors, checkAuth } from '../lib/auth.js';

export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Health check is public (no auth) so the tool can test connectivity
  res.status(200).json({
    ok: true,
    service: 'SEO Parasite Pro Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    endpoints: ['/api/health', '/api/proxy', '/api/ping', '/api/index', '/api/captcha', '/api/whois', '/api/headers'],
    env: {
      has_secret: !!process.env.API_SECRET_KEY,
      has_groq:   !!process.env.GROQ_API_KEY,
      node:       process.version,
    }
  });
}
