// lib/auth.js — shared API key auth for all endpoints
export function checkAuth(req, res) {
  const secret = process.env.API_SECRET_KEY;
  if (!secret) return true; // no secret set = open (dev mode)
  const provided =
    req.headers['x-api-key'] ||
    req.headers['authorization']?.replace('Bearer ', '') ||
    req.query?.key;
  if (provided !== secret) {
    res.status(401).json({ error: 'Unauthorized', hint: 'Set X-API-Key header' });
    return false;
  }
  return true;
}

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key,Authorization');
}
