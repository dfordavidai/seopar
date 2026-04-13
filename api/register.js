// /api/register.js — Preset Platform Account Creator
// Handles server-side registration for AC_PLATFORMS via Playwright + mail.tm
// Deployed on Vercel with @sparticuz/chromium + playwright-core

import { chromium } from 'playwright-core';
import * as chromiumExec from '@sparticuz/chromium';

// ── Platform signup URLs ──────────────────────────────────────────────────────
const SIGNUP_MAP = {
  wordpress:  'https://wordpress.com/start/account/user',
  medium:     'https://medium.com/m/signin',
  reddit:     'https://www.reddit.com/register',
  quora:      'https://www.quora.com/signup',
  tumblr:     'https://www.tumblr.com/register',
  weebly:     'https://www.weebly.com/signup',
  blogger:    'https://www.blogger.com/about/',
  wix:        'https://users.wix.com/signin?signupFirst=true',
  devto:      'https://dev.to/enter?state=new-user',
  hashnode:   'https://hashnode.com/onboard',
  strikingly: 'https://app.strikingly.com/users/sign_up',
  site123:    'https://www.site123.com/signup',
};

const log = [];
const L = (msg, cls = 'tm') => { log.push({ msg, cls }); console.log(msg); };

// ── mail.tm inbox creation ────────────────────────────────────────────────────
async function createMailTmInbox() {
  // Get a domain
  const domR = await fetch('https://api.mail.tm/domains', { signal: AbortSignal.timeout(10000) });
  const domData = await domR.json();
  const domain = domData['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('mail.tm: no domains available');

  const rand = Math.random().toString(36).slice(2, 10);
  const address = `${rand}@${domain}`;
  const password = 'Mx' + Math.random().toString(36).slice(2, 12) + '!9';

  const accR = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!accR.ok) {
    const err = await accR.text();
    throw new Error('mail.tm account creation failed: ' + err);
  }

  // Get auth token
  const tokR = await fetch('https://api.mail.tm/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(10000),
  });
  const tokData = await tokR.json();
  if (!tokData.token) throw new Error('mail.tm: token fetch failed');

  return { address, password, token: tokData.token };
}

// ── Poll mail.tm for verification email ──────────────────────────────────────
async function pollMailTm(token, maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await fetch('https://api.mail.tm/messages', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    const msgs = data['hydra:member'] || [];
    if (msgs.length > 0) {
      // Fetch full message to get links
      const msgR = await fetch('https://api.mail.tm/messages/' + msgs[0].id, {
        headers: { Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(10000),
      });
      const msg = await msgR.json();
      const body = msg.text || msg.html || '';
      const linkMatch = body.match(/https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|activ|token)[^\s"'<>]*/i);
      if (linkMatch) return linkMatch[0];
    }
    L('  📬 Waiting for verification email… ' + Math.round((Date.now() - start) / 1000) + 's', 'tm');
  }
  return null;
}

// ── 2captcha solver ───────────────────────────────────────────────────────────
async function solve2captcha(page, captchaKey, pageUrl) {
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  });
  if (!siteKey) { L('  ⚠ No sitekey found for CAPTCHA', 't-warn'); return false; }

  const submitR = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `key=${captchaKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`,
  });
  const submitData = await submitR.json();
  if (submitData.status !== 1) { L('  ⚠ 2captcha submit failed: ' + JSON.stringify(submitData), 't-warn'); return false; }

  const captchaId = submitData.request;
  L('  ⏳ 2captcha task ' + captchaId + ' — waiting…', 'tm');

  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const resR = await fetch(`https://2captcha.com/res.php?key=${captchaKey}&action=get&id=${captchaId}&json=1`);
    const resData = await resR.json();
    if (resData.status === 1) {
      const token = resData.request;
      await page.evaluate(tok => {
        try { document.getElementById('g-recaptcha-response').value = tok; } catch (e) {}
        try {
          const cb = Object.values(window.___grecaptcha_cfg?.clients || {})[0]?.callback;
          if (typeof cb === 'function') cb(tok);
        } catch (e) {}
        try { if (typeof window.captchaCallback === 'function') window.captchaCallback(tok); } catch (e) {}
      }, token);
      L('  ✅ CAPTCHA solved & injected', 't-accent');
      return true;
    }
    if (resData.request === 'ERROR_CAPTCHA_UNSOLVABLE') break;
  }
  L('  ⚠ CAPTCHA solve timed out', 't-warn');
  return false;
}

// ── Fill a registration form generically ─────────────────────────────────────
async function fillForm(page, profile) {
  const inputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="file"]), select, textarea');
  const filled = [];
  for (const input of inputs) {
    try {
      const visible = await input.isVisible();
      if (!visible) continue;
      const tag  = await input.evaluate(el => el.tagName.toLowerCase());
      const type = await input.evaluate(el => (el.getAttribute('type') || 'text').toLowerCase());
      const name = await input.evaluate(el => el.getAttribute('name') || '');
      const id   = await input.evaluate(el => el.getAttribute('id') || '');
      const ph   = await input.evaluate(el => el.getAttribute('placeholder') || '');
      const combined = [name, id, ph].join(' ').toLowerCase();

      if (tag === 'select') {
        await input.evaluate(el => { if (el.options.length > 1) el.selectedIndex = 1; });
        filled.push('select:' + name);
        continue;
      }
      if (type === 'checkbox') {
        if (!(await input.isChecked())) await input.check().catch(() => {});
        filled.push('chk:' + name);
        continue;
      }

      let value = null;
      if (/confirm|password2|retype|repeat|verify/.test(combined)) value = profile.password;
      else if (/password|passwd|pwd/.test(combined) || type === 'password') value = profile.password;
      else if (/email|e-mail/.test(combined) || type === 'email') value = profile.email;
      else if (/user|login|handle|nick|screen/.test(combined)) value = profile.username;
      else if (/first.?name|fname|given/.test(combined)) value = profile.firstName;
      else if (/last.?name|lname|family|surname/.test(combined)) value = profile.lastName;
      else if (/\bname\b|full.?name|display.?name|real.?name/.test(combined)) value = profile.fullName;
      else if (/phone|mobile|tel/.test(combined) || type === 'tel') value = profile.phone;
      else if (/website|\burl\b|blog|homepage/.test(combined) || type === 'url') value = profile.website;
      else if (/bio|about|description/.test(combined)) value = profile.bio;
      else if (type === 'text' && /user|name/.test(combined)) value = profile.username;

      if (value !== null) {
        await input.fill(String(value));
        filled.push(name || id || type);
        await page.waitForTimeout(100 + Math.random() * 80);
      }
    } catch (e) { /* skip inaccessible field */ }
  }
  return filled;
}

// ── Submit the form ───────────────────────────────────────────────────────────
async function submitForm(page) {
  const selectors = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:text-matches("sign up", "i")', 'button:text-matches("register", "i")',
    'button:text-matches("create account", "i")', 'button:text-matches("join", "i")',
    'button:text-matches("get started", "i")', 'button:text-matches("next", "i")',
    '[data-testid*="submit"]', '[data-testid*="signup"]',
    '.submit-btn', '#submit-btn', '#registerBtn', '#signupBtn',
    'form button:last-of-type',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        L('  🖱 Clicking: ' + sel, 'tm');
        await btn.click();
        return true;
      }
    } catch (e) {}
  }
  // Fallback: form.submit()
  const done = await page.evaluate(() => {
    const f = document.querySelector('form');
    if (f) { f.submit(); return true; }
    return false;
  });
  if (done) { L('  🖱 form.submit() fallback', 'tm'); return true; }
  return false;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-API-Key,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  log.length = 0;

  const { platform, username, password, captchaKey, useMailTm, autoVerify, proxy } = req.body || {};
  if (!platform || !username || !password) {
    return res.status(400).json({ error: 'platform, username, password required' });
  }

  const signupUrl = SIGNUP_MAP[platform];
  if (!signupUrl) {
    return res.status(400).json({ error: 'Unknown platform: ' + platform, log });
  }

  const result = {
    ok: false, email: '', apiKey: null, profileUrl: null,
    verifyStatus: 'unverified', note: '', log,
  };

  let browser, inbox;

  try {
    // Create mail.tm inbox if requested
    if (useMailTm) {
      L('📧 Creating mail.tm inbox…', 't-accent');
      inbox = await createMailTmInbox();
      result.email = inbox.address;
      L('  ✔ Inbox: ' + inbox.address, 't-info');
    } else {
      result.email = username + '@tempmail.com';
    }

    const profile = {
      email: result.email,
      username,
      password,
      firstName: username.slice(0, 8),
      lastName: 'User',
      fullName: username.slice(0, 8) + ' User',
      phone: '5' + Math.floor(Math.random() * 1e9).toString().padStart(9, '0'),
      website: 'https://' + username + '.com',
      bio: 'Digital content creator and SEO enthusiast.',
      city: 'New York',
      country: 'US',
      zipcode: '10001',
      birthYear: '1990',
      birthMonth: '06',
      birthDay: '15',
    };

    // Launch Playwright browser
    L('🌐 Launching Chromium → ' + signupUrl, 't-accent');
    const launchOpts = {
      executablePath: await chromiumExec.executablePath(),
      args: [...chromiumExec.args, '--no-sandbox', '--disable-setuid-sandbox'],
      headless: chromiumExec.headless,
    };
    if (proxy) launchOpts.proxy = { server: proxy };
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    const page = await context.newPage();

    await page.goto(signupUrl, { waitUntil: 'networkidle', timeout: 30000 });
    L('  ✔ Page loaded: ' + (await page.title()), 't-info');

    await page.waitForTimeout(1500);

    // Fill the form
    L('  🔎 Scanning and filling form fields…', 'tm');
    const filled = await fillForm(page, profile);
    L('  ✔ Filled ' + filled.length + ' field(s): ' + filled.slice(0, 5).join(', '), 't-info');

    // CAPTCHA
    const hasCaptcha = await page.evaluate(() =>
      !!(document.querySelector('.g-recaptcha,.h-captcha,[data-sitekey],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]'))
    );
    if (hasCaptcha && captchaKey) {
      L('  🧩 CAPTCHA detected — solving…', 't-accent');
      await solve2captcha(page, captchaKey, page.url());
    } else if (hasCaptcha) {
      L('  ⚠ CAPTCHA detected but no 2captcha key provided', 't-warn');
    }

    await page.waitForTimeout(500);

    // Submit
    const submitted = await submitForm(page);
    if (!submitted) {
      result.note = 'Could not find submit button';
      L('  ⚠ ' + result.note, 't-warn');
    }

    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const afterUrl = page.url();
    const afterBody = (await page.evaluate(() => document.body?.innerText?.toLowerCase().slice(0, 1500) || ''));

    const successSigs = ['thank', 'success', 'verify', 'check your email', 'welcome', 'confirm', 'account created', 'registered', 'almost done', 'one more step', 'sent you', 'activation'];
    const errorSigs   = ['already taken', 'already exists', 'already registered', 'username taken', 'email already', 'invalid', 'try again'];

    const isSuccess = successSigs.some(s => afterBody.includes(s)) || afterUrl !== signupUrl;
    const isError   = !isSuccess && errorSigs.some(s => afterBody.includes(s));

    if (isSuccess) {
      result.ok = true;
      result.verifyStatus = 'submitted-success';
      result.note = 'Registration accepted → ' + afterUrl.slice(0, 80);
      result.profileUrl = afterUrl;
      L('  ✅ SUCCESS: ' + result.note, 't-accent');
    } else if (isError) {
      result.note = 'Form error detected on page';
      L('  ❌ ' + result.note, 't-err');
    } else {
      result.ok = submitted;
      result.note = submitted ? 'Submitted — outcome unclear' : 'Could not submit form';
      L('  ⚠ Ambiguous: ' + result.note, 't-warn');
    }

    // Try to extract profile URL
    if (!result.profileUrl || result.profileUrl === signupUrl) {
      const pUrl = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href*="/profile"],a[href*="/user"],a[href*="/u/"],a[href*="/member"],a[href*="/@"]')];
        return links[0]?.href || '';
      });
      if (pUrl) result.profileUrl = pUrl;
    }

    // Auto-verify email
    if (result.ok && autoVerify && inbox) {
      L('  📬 Polling mail.tm inbox for verification link…', 'tm');
      const verifyLink = await pollMailTm(inbox.token);
      if (verifyLink) {
        L('  🔗 Verify link found: ' + verifyLink.slice(0, 60) + '…', 't-info');
        result.verifyStatus = 'verify-link-found';
        // Click the link in the browser
        try {
          await page.goto(verifyLink, { waitUntil: 'networkidle', timeout: 25000 });
          await page.waitForTimeout(2000);
          const verBody = (await page.evaluate(() => document.body?.innerText?.toLowerCase() || ''));
          if (/success|verified|confirmed|activated|thank|welcome/.test(verBody)) {
            result.verifyStatus = 'verified';
            L('  ✅ Email verified — account fully activated!', 't-accent');
          } else {
            L('  ⚠ Clicked verify link but outcome unclear', 't-warn');
          }
        } catch (e) {
          L('  ⚠ Could not click verify link: ' + e.message, 't-warn');
        }
      } else {
        L('  ⚠ No verification email arrived within 90s', 't-warn');
        result.verifyStatus = 'no-email-arrived';
      }
    } else if (!inbox) {
      result.verifyStatus = 'no-email-required';
    }

  } catch (err) {
    result.ok = false;
    result.note = 'Playwright error: ' + err.message;
    L('❌ Fatal: ' + err.message, 't-err');
  } finally {
    try { await browser?.close(); } catch (e) {}
  }

  result.log = log;
  return res.status(200).json(result);
}
