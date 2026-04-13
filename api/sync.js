// api/sync.js — server-side Supabase sync proxy
// Lets the tool read/write to Supabase without exposing the service-role key in the browser
// The browser sends its anon key; server uses service-role key for elevated ops if needed

import { cors, checkAuth } from '../lib/auth.js';

const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || ''; // service role key (server only)

async function supaRequest(path, method, body, anonKey) {
  const key = SUPA_KEY || anonKey;
  if (!SUPA_URL || !key) throw new Error('Supabase not configured on server');
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || ('HTTP ' + r.status));
  return data;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { action, table, data, filter, anonKey } = req.body || {};

  if (!table) return res.status(400).json({ error: 'table required' });

  // Whitelist tables the tool is allowed to touch
  const ALLOWED = ['spp_keywords','spp_links','spp_accounts','spp_sessions','spp_settings','spp_jobs','spp_backlinks','spp_projects'];
  if (!ALLOWED.includes(table)) return res.status(400).json({ error: 'Table not allowed: ' + table });

  try {
    let result;
    switch (action) {
      case 'upsert':
        if (!data) return res.status(400).json({ error: 'data required for upsert' });
        result = await supaRequest(table, 'POST', Array.isArray(data) ? data : [data], anonKey);
        break;

      case 'select': {
        let qs = table + '?select=*&order=updated_at.desc&limit=1000';
        if (filter) qs += '&' + new URLSearchParams(filter).toString();
        result = await supaRequest(qs, 'GET', null, anonKey);
        break;
      }

      case 'delete': {
        if (!filter) return res.status(400).json({ error: 'filter required for delete' });
        let qs = table + '?' + new URLSearchParams(filter).toString();
        result = await supaRequest(qs, 'DELETE', null, anonKey);
        break;
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action + '. Use upsert|select|delete' });
    }

    res.status(200).json({ ok: true, action, table, rows: Array.isArray(result) ? result.length : 1, data: result });
  } catch (e) {
    res.status(200).json({ ok: false, error: e.message });
  }
}
