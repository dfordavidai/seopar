// api/captcha.js — built-in captcha solving proxy
// Routes to: 2captcha / anti-captcha / capmonster based on configured API keys
// Falls back to returning a "manual" flag for browser-assisted solving
// NO illegal bypass code — only forwards to legitimate paid solving services

import { cors, checkAuth } from '../lib/auth.js';

const SOLVERS = {
  twocaptcha:  { submit: 'https://2captcha.com/in.php',    result: 'https://2captcha.com/res.php'    },
  anticaptcha: { submit: 'https://api.anti-captcha.com/createTask', result: 'https://api.anti-captcha.com/getTaskResult' },
  capmonster:  { submit: 'https://api.capmonster.cloud/createTask', result: 'https://api.capmonster.cloud/getTaskResult'  },
};

async function pollResult(solver, taskId, key, maxWait = 120000) {
  const deadline = Date.now() + maxWait;
  await new Promise(r => setTimeout(r, 5000)); // initial wait
  while (Date.now() < deadline) {
    let r, data;
    if (solver === 'twocaptcha') {
      r = await fetch(`${SOLVERS.twocaptcha.result}?action=get&key=${key}&id=${taskId}`);
      const text = await r.text();
      if (text.startsWith('OK|')) return { ok: true, solution: text.split('|')[1] };
      if (text !== 'CAPCHA_NOT_READY') throw new Error('2captcha error: ' + text);
    } else {
      r = await fetch(SOLVERS[solver].result, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: key, taskId })
      });
      data = await r.json();
      if (data.status === 'ready') return { ok: true, solution: data.solution?.gRecaptchaResponse || data.solution?.text };
      if (data.errorId) throw new Error(data.errorDescription || 'Captcha solver error');
    }
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error('Captcha solve timeout after ' + (maxWait / 1000) + 's');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    type = 'recaptcha_v2', // recaptcha_v2 | recaptcha_v3 | hcaptcha | image | text
    sitekey,
    pageurl,
    imageBase64,
    solver: preferredSolver,
    apiKey: clientKey,  // client can pass their own solver key
  } = req.body || {};

  // Determine which solver to use + API key
  const solverName = preferredSolver ||
    (process.env.CAPMONSTER_KEY  ? 'capmonster'  : null) ||
    (process.env.ANTICAPTCHA_KEY ? 'anticaptcha' : null) ||
    (process.env.TWOCAPTCHA_KEY  ? 'twocaptcha'  : null);

  const apiKey = clientKey ||
    (solverName === 'capmonster'  ? process.env.CAPMONSTER_KEY  : null) ||
    (solverName === 'anticaptcha' ? process.env.ANTICAPTCHA_KEY : null) ||
    (solverName === 'twocaptcha'  ? process.env.TWOCAPTCHA_KEY  : null);

  if (!solverName || !apiKey) {
    return res.status(200).json({
      ok: false,
      manual: true,
      message: 'No captcha solver configured. Add TWOCAPTCHA_KEY, ANTICAPTCHA_KEY, or CAPMONSTER_KEY to Vercel env vars, or pass apiKey in request body.'
    });
  }

  try {
    let taskId;

    if (solverName === 'twocaptcha') {
      // 2captcha uses form-style submission
      let body = `key=${apiKey}&json=1`;
      if (type === 'image' && imageBase64) {
        body += `&method=base64&body=${encodeURIComponent(imageBase64)}`;
      } else if (type === 'recaptcha_v2') {
        body += `&method=userrecaptcha&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}`;
      } else if (type === 'recaptcha_v3') {
        body += `&method=userrecaptcha&version=v3&googlekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}&action=verify&min_score=0.3`;
      } else if (type === 'hcaptcha') {
        body += `&method=hcaptcha&sitekey=${sitekey}&pageurl=${encodeURIComponent(pageurl)}`;
      }
      const r = await fetch(SOLVERS.twocaptcha.submit, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      const data = await r.json();
      if (!data.request || data.status !== 1) throw new Error('Submit failed: ' + JSON.stringify(data));
      taskId = data.request;
    } else {
      // Anti-captcha / CapMonster use JSON task format
      let task = {};
      if (type === 'image' && imageBase64) {
        task = { type: 'ImageToTextTask', body: imageBase64 };
      } else if (type === 'recaptcha_v2') {
        task = { type: 'NoCaptchaTaskProxyless', websiteURL: pageurl, websiteKey: sitekey };
      } else if (type === 'recaptcha_v3') {
        task = { type: 'RecaptchaV3TaskProxyless', websiteURL: pageurl, websiteKey: sitekey, minScore: 0.3, pageAction: 'verify' };
      } else if (type === 'hcaptcha') {
        task = { type: 'HCaptchaTaskProxyless', websiteURL: pageurl, websiteKey: sitekey };
      }
      const r = await fetch(SOLVERS[solverName].submit, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, task })
      });
      const data = await r.json();
      if (data.errorId) throw new Error(data.errorDescription || 'Task creation failed');
      taskId = data.taskId;
    }

    const result = await pollResult(solverName, taskId, apiKey);
    res.status(200).json({ ok: true, solver: solverName, taskId, ...result });

  } catch (e) {
    res.status(200).json({ ok: false, error: e.message, solver: solverName });
  }
}
