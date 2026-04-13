// api/whois.js — domain age, registration, expiry lookup via RDAP (free, no API key needed)
// Used by the expired domain finder and domain research modules

import { cors, checkAuth } from '../lib/auth.js';

function extractDomain(input) {
  try {
    const u = new URL(input.startsWith('http') ? input : 'https://' + input);
    return u.hostname.replace(/^www\./, '');
  } catch { return input.trim().replace(/^www\./, ''); }
}

// RDAP bootstrap — maps TLDs to RDAP servers
const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
let rdapBootstrap = null;

async function getRdapUrl(tld) {
  if (!rdapBootstrap) {
    try {
      const r = await fetch(RDAP_BOOTSTRAP, { signal: AbortSignal.timeout(5000) });
      rdapBootstrap = await r.json();
    } catch { return null; }
  }
  for (const [tlds, services] of rdapBootstrap.services || []) {
    if (tlds.includes(tld) && services.length) return services[0];
  }
  return null;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;

  const raw = (req.method === 'POST' ? req.body?.domain : req.query?.domain) || '';
  if (!raw) return res.status(400).json({ error: 'Missing domain parameter' });

  const domain = extractDomain(raw);
  const tld = domain.split('.').slice(-1)[0].toLowerCase();

  try {
    const rdapBase = await getRdapUrl(tld);
    const rdapUrl = rdapBase
      ? rdapBase.replace(/\/$/, '') + '/domain/' + domain
      : 'https://rdap.org/domain/' + domain;

    const r = await fetch(rdapUrl, {
      headers: { 'Accept': 'application/rdap+json,application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (!r.ok) {
      return res.status(200).json({ domain, error: 'RDAP lookup failed: ' + r.status, status: r.status });
    }

    const data = await r.json();

    // Parse events (registration, expiry, last changed)
    const events = {};
    for (const ev of data.events || []) {
      events[ev.eventAction] = ev.eventDate;
    }

    // Parse nameservers
    const nameservers = (data.nameservers || []).map(ns =>
      typeof ns === 'string' ? ns : ns.ldhName
    );

    // Parse registrar from entities
    let registrar = '';
    for (const entity of data.entities || []) {
      if ((entity.roles || []).includes('registrar')) {
        registrar = entity.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || entity.handle || '';
        break;
      }
    }

    // Calculate domain age
    const regDate = events.registration ? new Date(events.registration) : null;
    const agedays = regDate ? Math.floor((Date.now() - regDate.getTime()) / 86400000) : null;

    res.status(200).json({
      domain,
      registered:   events.registration || null,
      expiry:       events.expiration   || null,
      lastChanged:  events['last changed'] || null,
      registrar,
      nameservers,
      status:       data.status || [],
      ageDays:      agedays,
      ageYears:     agedays ? +(agedays / 365).toFixed(1) : null,
      rdapUrl,
      raw: data
    });
  } catch (e) {
    res.status(200).json({ domain, error: e.message });
  }
}
