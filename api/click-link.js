// /api/click-link.js — Deploy to Vercel
// Clicks a verification link using a real browser (bypasses anti-bot)
import { chromium } from 'playwright-core';
import * as chromiumExec from '@sparticuz/chromium';

export default async function handler(req, res) {
  if(req.method!=='POST') return res.status(405).json({error:'Method Not Allowed'});
  const { url } = req.body||{};
  if(!url) return res.status(400).json({error:'url required'});
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: await chromiumExec.executablePath(),
      args: [...chromiumExec.args,'--no-sandbox'],
      headless: chromiumExec.headless,
    });
    const page = await browser.newPage();
    await page.goto(url, {waitUntil:'networkidle', timeout:30000});
    await page.waitForTimeout(2000);
    return res.status(200).json({ok:true, finalUrl: page.url()});
  } catch(e){
    return res.status(200).json({ok:false, error: e.message});
  } finally {
    try { await browser?.close(); } catch(e){}
  }
}
