// /api/universal-register.js — Deploy to Vercel (Node.js)
// npm install: playwright-core @playwright/browser-chromium node-fetch

import { chromium } from 'playwright-core';
import * as chromiumExec from '@sparticuz/chromium';

const FIELD_MAP = {
  // email patterns
  email: ['email','e-mail','mail','correo','e_mail','emailaddress','user_email','account_email','login_email'],
  // username
  username: ['username','user_name','userid','user','login','handle','nickname','account_name','nick','screen_name','display_name','user_login','uname'],
  // password
  password: ['password','passwd','pass','pwd','contraseña','mot_de_passe','passwort','new_password','password1','account_password','user_password'],
  password2: ['password_confirmation','password2','confirm_password','retype_password','repeat_password','confirmpassword','repassword','pass2','verify_password','password_confirm'],
  // name fields
  firstName: ['first_name','firstname','fname','given_name','forename','name_first','first','prenom','vorname'],
  lastName: ['last_name','lastname','lname','family_name','surname','name_last','last','nom','nachname'],
  fullName: ['name','full_name','fullname','your_name','display_name','real_name','author_name','realname','complete_name'],
  // phone
  phone: ['phone','telephone','tel','mobile','cell','phone_number','phonenumber','mobile_number','contact_number'],
  // other
  website: ['website','url','site','homepage','web','blog','portfolio','site_url'],
  bio: ['bio','about','description','about_me','biography','introduction','intro','profile_description'],
  city: ['city','town','locality'],
  country: ['country','nation','country_code'],
  zipcode: ['zip','zipcode','postal_code','postcode','zip_code'],
  birthYear: ['birth_year','year','dob_year','birthday_year','year_of_birth'],
  birthMonth: ['birth_month','month','dob_month','birthday_month'],
  birthDay: ['birth_day','day','dob_day','birthday_day'],
  gender: ['gender','sex'],
};

// Find which profile field maps to an input element
function detectField(el){
  const name = (el.getAttribute('name')||'').toLowerCase().replace(/[[]]/g,'-');
  const id   = (el.getAttribute('id')||'').toLowerCase();
  const ph   = (el.getAttribute('placeholder')||'').toLowerCase();
  const lbl  = el.closest?.('label')?.textContent?.toLowerCase() || '';
  const aria = (el.getAttribute('aria-label')||'').toLowerCase();
  const combined = [name,id,ph,lbl,aria].join(' ');
  for(const [field, patterns] of Object.entries(FIELD_MAP)){
    if(patterns.some(p => combined.includes(p))) return field;
  }
  // type-based fallback
  const type = (el.getAttribute('type')||'text').toLowerCase();
  if(type==='email') return 'email';
  if(type==='password') return 'password';
  if(type==='tel') return 'phone';
  if(type==='url') return 'website';
  return null;
}

export default async function handler(req, res) {
  if(req.method!=='POST') return res.status(405).json({error:'Method Not Allowed'});
  const {url, profile, captchaKey, proxy, headless=true, autoVerify} = req.body||{};
  if(!url||!profile) return res.status(400).json({error:'url and profile required'});

  const log = [];
  const L = (msg,cls='tm') => { log.push({msg,cls}); console.log(msg); };

  let browser, context, page;
  const result = {
    ok:false, note:'', log,
    formFields:[], captchaSolved:false,
    verifyStatus:'unverified', verifyLink:null, profileUrl:null,
    submitStatus:''
  };

  try {
    L(`🌐 Launching Chromium → ${url}`,'t-accent');
    const launchOpts = {
      executablePath: await chromiumExec.executablePath(),
      args: [...chromiumExec.args,'--no-sandbox','--disable-setuid-sandbox'],
      headless: chromiumExec.headless,
    };
    if(proxy) launchOpts.proxy = {server: proxy};
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext({
      userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:{width:1280,height:800},
      locale:'en-US',
    });
    page = await context.newPage();

    // ── Navigate to the target URL ───────────────────────────────────────────
    await page.goto(url, {waitUntil:'networkidle', timeout:30000});
    L(`  ✔ Page loaded: ${await page.title()}`,'t-info');

    // ── Find registration page if not already on it ──────────────────────────
    const signupSelectors = [
      'a[href*="signup"]','a[href*="register"]','a[href*="join"]','a[href*="create-account"]',
      'a[href*="sign-up"]','a[href*="create_account"]','a[href*="new-account"]','a[href*="enroll"]',
      'a:text-matches("sign up","i")','a:text-matches("register","i")','a:text-matches("create account","i")',
      'a:text-matches("join","i")','a:text-matches("get started","i")','a:text-matches("join free","i")',
      'button:text-matches("sign up","i")','button:text-matches("register","i")',
    ];

    // Check if we're already on a registration page
    const isRegPage = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.toLowerCase()||'';
      const formInputs = document.querySelectorAll('input[type="password"],input[name*="password"],input[name*="email"]').length;
      return formInputs >= 2 || /sign.?up|register|create.+account|join.+free/i.test(bodyText.slice(0,500));
    });

    if(!isRegPage){
      L('  🔍 Not on reg page — searching for signup link…','tm');
      let found = false;
      for(const sel of signupSelectors){
        try {
          const el = await page.$(sel);
          if(el){
            const href = await el.getAttribute('href')||'';
            L(`  → Found signup link: ${href||sel}`,'t-info');
            await el.click();
            await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});
            found = true; break;
          }
        } catch(e){}
      }
      if(!found) {
        L('  ⚠ Could not find signup link — attempting to fill forms on current page','t-warn');
      }
    } else {
      L('  ✔ Already on registration page','t-info');
    }

    await page.waitForTimeout(1500);

    // ── Detect and fill all form fields ─────────────────────────────────────
    L('  🔎 Scanning form fields…','tm');
    const fieldsFilled = [];

    const inputs = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="file"]), select, textarea');
    L(`  → Found ${inputs.length} form field(s)`,'tm');

    for(const input of inputs){
      try {
        const tagName = await input.evaluate(el=>el.tagName.toLowerCase());
        const type    = await input.evaluate(el=>(el.getAttribute('type')||'text').toLowerCase());
        const name    = await input.evaluate(el=>el.getAttribute('name')||'');
        const isVisible = await input.isVisible();
        if(!isVisible) continue;

        if(tagName==='select'){
          // Select first non-empty option, or detect gender/country
          await input.evaluate(el=>{
            if(el.options.length>1) el.selectedIndex=1;
            // Try to match gender
            const opts=[...el.options].map(o=>o.value.toLowerCase());
            const maleIdx=opts.findIndex(o=>o==='male'||o==='m');
            if(maleIdx>-1) el.selectedIndex=maleIdx;
          });
          fieldsFilled.push('select:'+name);
          continue;
        }

        if(type==='checkbox'){
          // Check it (agree to terms, newsletter etc.)
          const checked = await input.isChecked();
          if(!checked) await input.check().catch(()=>{});
          fieldsFilled.push('checkbox:'+name);
          continue;
        }

        if(type==='radio'){
          await input.check().catch(()=>{});
          fieldsFilled.push('radio:'+name);
          continue;
        }

        const field = await input.evaluate(detectField.toString()+'\n return detectField(arguments[0]);');
        // ↑ We can't pass the fn directly cross-page; do it differently:
        const nameAttr = await input.evaluate(el=>el.getAttribute('name')||'');
        const idAttr   = await input.evaluate(el=>el.getAttribute('id')||'');
        const phAttr   = await input.evaluate(el=>el.getAttribute('placeholder')||'');
        const combined = [nameAttr,idAttr,phAttr].join(' ').toLowerCase();

        let value = null;
        const pw = /password|passwd|pass\b|pwd/i;
        const pw2 = /confirm|password2|retype|repeat|verify/i;
        const em = /email|e-mail|mail/i;
        const un = /user|login|handle|nick|screen/i;
        const fn = /first.?name|fname|given/i;
        const ln = /last.?name|lname|family|surname/i;
        const full = /\bname\b|full.?name|display.?name|real.?name/i;
        const ph2 = /phone|mobile|tel/i;
        const web = /website|\burl\b|blog|homepage/i;
        const bio2 = /bio|about|description/i;
        const city = /city|town/i;
        const country = /country/i;
        const zip = /zip|postal/i;
        const bday = /birth|dob|birthday|\byear\b|\bmonth\b|\bday\b/i;

        if(pw2.test(combined) && !pw2.test(combined.split('password')[0])) value=profile.password;
        else if(pw.test(combined)) value=profile.password;
        else if(em.test(combined)) value=profile.email;
        else if(un.test(combined)) value=profile.username;
        else if(fn.test(combined)) value=profile.firstName;
        else if(ln.test(combined)) value=profile.lastName;
        else if(full.test(combined)) value=profile.fullName;
        else if(ph2.test(combined)) value=profile.phone;
        else if(web.test(combined)) value=profile.website;
        else if(bio2.test(combined)) value=profile.bio;
        else if(city.test(combined)) value=profile.city;
        else if(country.test(combined)) value=profile.country;
        else if(zip.test(combined)) value=profile.zipcode;
        else if(/birth.?year|year.?of.?birth/i.test(combined)) value=String(profile.birthYear);
        else if(/birth.?month|month.?of.?birth/i.test(combined)) value=profile.birthMonth;
        else if(/birth.?day|day.?of.?birth/i.test(combined)) value=profile.birthDay;
        else if(type==='email') value=profile.email;
        else if(type==='password') value=profile.password;
        else if(type==='tel') value=profile.phone;
        else if(type==='url') value=profile.website;
        else if(type==='text' || type==='') {
          // Try to infer from any signal
          if(/user|name/i.test(combined)) value=profile.username;
        }

        if(value!==null){
          await input.fill(String(value));
          fieldsFilled.push(nameAttr||idAttr||type);
          L(`    ✔ Filled [${nameAttr||idAttr||type}] = ${type==='password'?'***':String(value).slice(0,30)}`,'tm');
          await page.waitForTimeout(120+Math.random()*80);
        }
      } catch(e){ /* field inaccessible, skip */ }
    }

    result.formFields = fieldsFilled;
    L(`  ✔ Filled ${fieldsFilled.length} field(s)`,'t-info');

    // ── CAPTCHA detection & solving ───────────────────────────────────────────
    const hasCaptcha = await page.evaluate(()=>{
      return !!(document.querySelector('.g-recaptcha,.h-captcha,[data-sitekey],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],#cf-challenge-running,#challenge-form'))||
             (document.body?.innerHTML||'').includes('data-sitekey');
    });

    if(hasCaptcha && captchaKey){
      L('  🧩 CAPTCHA detected — solving via 2captcha…','t-accent');
      try {
        // Get site key
        const siteKey = await page.evaluate(()=>{
          const el = document.querySelector('[data-sitekey]');
          return el?.getAttribute('data-sitekey')||'';
        });
        const pageUrl = page.url();

        if(siteKey){
          // Submit to 2captcha
          const submitR = await fetch('https://2captcha.com/in.php',{
            method:'POST',
            headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:`key=${captchaKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`
          });
          const submitData = await submitR.json();
          if(submitData.status===1){
            const captchaId = submitData.request;
            L(`    ⏳ 2captcha task ID: ${captchaId} — waiting for solution…`,'tm');
            // Poll for result (max 120s)
            let solution = null;
            for(let attempt=0;attempt<24;attempt++){
              await new Promise(r=>setTimeout(r,5000));
              const resR = await fetch(`https://2captcha.com/res.php?key=${captchaKey}&action=get&id=${captchaId}&json=1`);
              const resData = await resR.json();
              if(resData.status===1){ solution=resData.request; break; }
              if(resData.request==='ERROR_CAPTCHA_UNSOLVABLE') break;
            }
            if(solution){
              // Inject solution into g-recaptcha-response
              await page.evaluate(token=>{
                try {
                  document.getElementById('g-recaptcha-response').style.display='block';
                  document.getElementById('g-recaptcha-response').value=token;
                } catch(e){}
                try {
                  const cb = window.___grecaptcha_cfg?.clients?.[0]?.callback;
                  if(typeof cb==='function') cb(token);
                } catch(e){}
                try { window.captchaCallback?.(token); } catch(e){}
              }, solution);
              result.captchaSolved=true;
              L('    ✅ CAPTCHA solved and injected!','t-accent');
            } else {
              L('    ⚠ CAPTCHA solution timed out','t-warn');
            }
          } else {
            L(`    ⚠ 2captcha submit failed: ${JSON.stringify(submitData)}`,'t-warn');
          }
        } else {
          L('    ⚠ Could not extract sitekey — manual solve needed','t-warn');
        }
      } catch(e){
        L(`    ❌ CAPTCHA solve error: ${e.message}`,'t-err');
      }
    } else if(hasCaptcha && !captchaKey){
      L('  ⚠ CAPTCHA detected but no 2captcha key — registration may fail','t-warn');
    }

    await page.waitForTimeout(500);

    // ── Click submit ─────────────────────────────────────────────────────────
    L('  🖱 Looking for submit button…','tm');
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:text-matches("sign up","i")',
      'button:text-matches("register","i")',
      'button:text-matches("create account","i")',
      'button:text-matches("join","i")',
      'button:text-matches("get started","i")',
      'button:text-matches("next","i")',
      'button:text-matches("continue","i")',
      '[data-testid*="submit"]',
      '[data-testid*="signup"]',
      'form button:last-of-type',
      '.submit-btn','#submit-btn','#registerBtn','#signupBtn',
    ];

    let submitted = false;
    for(const sel of submitSelectors){
      try {
        const btn = await page.$(sel);
        if(btn && await btn.isVisible()){
          L(`    → Clicking: ${sel}`,'tm');
          await btn.click();
          submitted=true; break;
        }
      } catch(e){}
    }

    if(!submitted){
      // Fallback: submit the form
      const submitted2 = await page.evaluate(()=>{
        const form = document.querySelector('form');
        if(form){ form.submit(); return true; }
        return false;
      });
      if(submitted2){ submitted=true; L('    → Form.submit() called as fallback','tm'); }
    }

    if(!submitted){ L('  ⚠ Could not find submit button','t-warn'); result.submitStatus='no-submit-found'; }
    else { L('  ✔ Submit clicked','t-info'); result.submitStatus='submitted'; }

    // ── Wait for success signal ───────────────────────────────────────────────
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});

    const afterUrl = page.url();
    const afterBody = await page.evaluate(()=>document.body?.innerText?.toLowerCase().slice(0,1000)||'');
    L(`  → Post-submit URL: ${afterUrl}`,'tm');

    const successSignals = ['thank','success','verify','check your email','welcome','confirm','account created','registered','almost done','one more step','sent you','activation'];
    const errorSignals   = ['error','invalid','already taken','already exists','already registered','username taken','email already','try again','failed'];

    const isSuccess = successSignals.some(s=>afterBody.includes(s)) || afterUrl!==url;
    const isError   = !isSuccess && errorSignals.some(s=>afterBody.includes(s));

    if(isSuccess){
      result.ok=true; result.note='Registration accepted — '+afterUrl.slice(0,80);
      result.verifyStatus='submitted-success';
      result.profileUrl=afterUrl;
      L(`  ✅ SUCCESS: ${result.note}`,'t-accent');
    } else if(isError){
      result.ok=false; result.note='Form error detected on page';
      L(`  ❌ Error signals detected on page`,'t-err');
    } else {
      // Ambiguous — mark as likely success if we submitted
      result.ok=submitted; result.note=submitted?'Submitted — outcome unclear (no explicit success msg)':'Could not submit form';
      L(`  ⚠ Ambiguous outcome — assuming ${submitted?'success':'failure'}`,'t-warn');
    }

    // Extract profile URL if visible
    if(!result.profileUrl){
      try {
        const pUrl = await page.evaluate(()=>{
          const links = [...document.querySelectorAll('a[href*="/profile"],a[href*="/user"],a[href*="/u/"],a[href*="/member"],a[href*="/@"]')];
          return links[0]?.href||'';
        });
        if(pUrl) result.profileUrl=pUrl;
      } catch(e){}
    }

  } catch(err){
    result.ok=false; result.note='Playwright error: '+err.message;
    L(`❌ Fatal: ${err.message}`,'t-err');
  } finally {
    try { await browser?.close(); } catch(e){}
  }

  return res.status(200).json(result);
}
