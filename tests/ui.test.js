import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ejs from 'ejs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(root, f), 'utf8');
const files = d => readdirSync(path.join(root,d),{recursive:true}).filter(f=>/\.(ejs|js)$/.test(f)).map(f=>path.join(d,f));
const ejsRender = (src, data) => ejs.render(src, data);

test('CSP-safe UI and studio4n assets',()=>{for(const f of [...files('views'),...files('public/js')]){const s=read(f);assert.doesNotMatch(s,/\bon\w+\s*=/i,f);assert.doesNotMatch(s,/<script\b(?![^>]*\bsrc=)/i,f);assert.doesNotMatch(s,/\beval\s*\(|new\s+Function/i,f)} for(const f of ['views/layout.ejs','views/login.ejs']) assert.match(read(f),/\?v=studio4n/)});
test('live-only UI removes mock and fake QR controls',()=>{const all=['views/layout.ejs','views/login.ejs','views/pages/orders.ejs','views/pages/accounts.ejs','views/pages/settings.ejs','views/pages/docs.ejs','views/pages/transactions.ejs','public/js/pages.js','public/js/app.js'].map(read).join('\n');assert.doesNotMatch(all,/PAYGATE-DEMO|simulate-payment|Simulasi bayar|value="mock"|Mock tetap|Mock aktif/i);assert.match(all,/legacy_unverified|Order lama dari sistem sebelumnya/i)});
test('orders fail closed until owner active account',()=>{const s=read('public/js/pages.js');for(const n of ['accountsBusy','accountsFailed','eligibleProviders','payment_origin === "live"','lab_unofficial === true']) assert.ok(s.includes(n),n);assert.match(read('views/pages/orders.ejs'),/data-action="open-create" disabled/);assert.match(read('views/pages/orders.ejs'),/id="btnCreate"[^>]*disabled/)});
test('GoPay wizard has scoped fields, OTP, discovery, consent and real API calls',()=>{const v=read('views/pages/accounts.ejs'),s=read('public/js/pages.js');for(const id of ['gpLoginDialog','gpPhone','gpPaygatePassword','gpRiskConsent','gpOtp','gpMerchant','gpOtpChannel']) assert.match(v,new RegExp(`id="${id}"`));for(const route of ['/api/accounts/login/start','/api/accounts/login/verify','/api/accounts/login/finish','/api/accounts/login/cancel']) assert.ok(s.includes(route));for(const word of ['attempt_id','merchants','aria-busy']) assert.ok(s.includes(word));assert.match(v,/<option value="whatsapp"/);assert.match(v,/<option value="sms"/);assert.match(s,/otp_channel:\$\("gpOtpChannel"\)\.value/);assert.match(v,/OTP lewat/i);assert.doesNotMatch(s,/localStorage|sessionStorage/);assert.match(v,/bukan API partner resmi/i)});
test('CSRF helper and dialogs/mobile accessibility remain',()=>{const a=read('public/js/app.js');assert.match(a,/X-CSRF-Token/);assert.match(a,/credentials: "same-origin"/);assert.match(a,/\.showModal\(/);for(const f of ['views/pages/orders.ejs','views/pages/accounts.ejs']) assert.match(read(f),/<dialog[^>]*aria-labelledby=/);assert.match(read('views/partials/sidebar.ejs'),/sidebarScrim/)});
test('owner rendering never leaks config secrets',()=>{const cfg={labUnofficialEnabled:true,labUserId:7,gopayLab:{accessToken:'SECRET_SENTINEL'}};const render=f=>ejs.render(read(f),{config:cfg,user:{id:7},active:'accounts',title:'x',body:'',error:null,next:'/',csrfToken:'x'},{filename:path.join(root,f)});assert.match(render('views/pages/accounts.ejs'),/data-lab-eligible="true"/);assert.doesNotMatch(render('views/pages/accounts.ejs'),/SECRET_SENTINEL/);assert.doesNotMatch(render('views/layout.ejs'),/LAB UNOFFICIAL|risk-banner/)});
test('settings real read-only contract',()=>{const v=read('views/pages/settings.ejs'),s=read('public/js/pages.js');assert.doesNotMatch(v,/Default Provider|Mock/);for(const id of ['setPoll','setTolerance','setTtl']) assert.match(v,new RegExp(`id="${id}"[^>]*readonly`));assert.match(s,/s\.poll_interval_ms/);assert.match(s,/s\.payment_tolerance/)});

test('theme, reduced motion, labels, native focus and password route retained',()=>{for(const f of files('views')){const s=read(f);for(const m of s.matchAll(/<(?:input|select)\b[^>]*\bid="([^"<]+)"[^>]*>/g))assert.ok(s.includes(`for="${m[1]}"`),`${f} label ${m[1]}`);assert.doesNotMatch(s,/fonts\.(googleapis|gstatic)\.com/)}const css=read('public/css/app.css');assert.match(css,/@media \(prefers-reduced-motion: reduce\)/);assert.match(css,/scroll-behavior:\s*auto/);assert.doesNotMatch(css,/@view-transition|transition:\s*(?:all\b|[.\d])/);const t=read('public/js/theme.js');assert.match(t,/paygate_theme/);assert.match(t,/paygate_accent/);assert.match(t,/prefers-color-scheme/);const a=read('public/js/app.js');assert.match(a,/event\.shiftKey/);assert.match(a,/sidebarScrim/);assert.match(read('public/js/pages.js'),/PayGate\.api\("\/change-password"/)});

test('clean design keeps neutral surfaces, semantic navigation and clear page hierarchy',()=>{
  const css=read('public/css/app.css');
  for(const selector of ['.sidebar','.brand-logo','.avatar','.auth-side']) {
    const rule=css.match(new RegExp('\\'+selector+'\\s*\\{([^}]+)\\}'));
    assert.ok(rule, selector); assert.doesNotMatch(rule[1],/gradient\(/,selector);
  }
  assert.match(css,/--bg:\s*#f7f8fa/i);
  for(const page of ['dashboard','orders','accounts','apikeys','transactions','settings','docs']) assert.match(read('views/pages/'+page+'.ejs'),/class="page-heading"/,page);
  assert.match(read('views/partials/sidebar.ejs'),/aria-current/);
  assert.doesNotMatch(read('views/login.ejs'),/👋|🔐|⚡|🔑|📱|🌙/u);
});

test('Shopee password form is owner-scoped, request-only and separates session import',()=>{
  const src=read('views/pages/accounts.ejs'),s=read('public/js/pages.js');
  const owner=ejsRender(src,{config:{labUnofficialEnabled:true,labUserId:7},user:{id:7}});
  const client=ejsRender(src,{config:{labUnofficialEnabled:true,labUserId:7},user:{id:8}});
  for(const id of ['spLoginDialog','spIdentifier','spMerchantPassword','spPaygatePassword','spOtp','spChoice','spQris','spConsent'])assert.ok(owner.includes(`id="${id}"`));
  for(const id of ['spGuideDialog','spConnectDialog','spToken','spMerchant','spStore','spCQris'])assert.ok(owner.includes(`id="${id}"`));
  for(const id of ['spGuideDialog','spConnectDialog','spToken'])assert.ok(!client.includes(`id="${id}"`));
  assert.ok(s.includes('/api/accounts/shopee/login/')); assert.match(s,/start:"start",otp:"verify",store:"finish"/);
  assert.match(s,/login\?\.shopeepay\?\.available/);
  assert.doesNotMatch(s,/localStorage|sessionStorage/);
});

test('official onboarding links are distinct from private connection controls',()=>{
  const v=read('views/pages/accounts.ejs');
  for(const url of ['https://developer.gobiz.com/contact-us','https://product.shopeepay.co.id/integration/get-started/javascript/','https://dashboard.midtrans.com/register'])assert.ok(v.includes(url));
  assert.match(v,/Belum terhubung ke API resmi/);
});

test('account flow has password login, consented automatic validation and no duplicate header actions',()=>{
  const v=read('views/pages/accounts.ejs'),s=read('public/js/pages.js'),layout=read('views/layout.ejs');
  for(const id of ['spLoginDialog','gpAutoCheck','spAutoCheck'])assert.ok(v.includes(`id="${id}"`));
  assert.match(v,/Password Shopee/);
  assert.match(v,/Simpan &amp; aktifkan/);
  assert.match(s,/afterSave/);
  assert.doesNotMatch(layout,/data-action="info"|href="\/settings"/);
});

test('ToS remains accessible without recurring warning banners' ,()=>{
  for(const f of ['views/layout.ejs','views/login.ejs','views/pages/accounts.ejs','views/pages/docs.ejs','views/pages/transactions.ejs']) assert.doesNotMatch(read(f),/risk-banner|LAB UNOFFICIAL|class="alert alert-warning"/,f);
  assert.match(read('views/partials/sidebar.ejs'),/href="\/tos"/);
  assert.match(read('views/partials/login-body.ejs'),/href="\/terms\/details"/);
  assert.match(read('views/login.ejs'),/include\('partials\/login-body'/);
  assert.match(read('views/terms.ejs'),/include\('partials\/login-body'/);
});

test('consent stays compact, shared login inert and external script never accepts on dismissal',()=>{
  const view=read('views/terms.ejs'),script=read('public/js/terms.js'),css=read('public/css/app.css');
  assert.match(view,/loginInert: true, error: null/);
  assert.match(read('views/partials/login-body.ejs'),/inert aria-hidden="true"/);
  assert.match(view,/<dialog[^>]*open[^>]*aria-labelledby="termsDialogTitle"/);
  assert.match(view,/href="\/terms\/details" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(view,/<details|<table|partials\/terms-content|method="dialog"/);
  assert.match(script,/\.showModal\(/);
  assert.match(script,/addEventListener\('cancel'/);
  assert.match(script,/event\.preventDefault\(\)/);
  assert.match(script,/termsDecline/);
  assert.match(script,/event\.shiftKey/);
  assert.match(script,/last\.focus\(\)/);
  assert.match(script,/first\.focus\(\)/);
  assert.match(css,/\.consent-dialog \.btn-primary\s*\{[^}]*background:\s*#047857;\s*color:\s*#fff;/);
  assert.doesNotMatch(script,/\.submit\(|requestSubmit|fetch\(|document\.cookie|accepted\s*=/);
  assert.match(css,/\.consent-dialog\s*\{[^}]*max-width:\s*480px/);
  assert.match(css,/\.license-raw pre\s*\{[^}]*white-space:\s*pre-wrap/);
});

test('no duplicate dashboard create or inert poll controls',()=>{
  assert.doesNotMatch(read('views/pages/dashboard.ejs'),/Buat Order/);
  assert.doesNotMatch(read('views/pages/transactions.ejs')+read('public/js/pages.js'),/poll-now|pollNow/);
  assert.doesNotMatch(read('views/pages/orders.ejs'),/\(memuat status\)/);
});

test('create locks duplicate submission and rechecks eligibility after response',()=>{const s=read('public/js/pages.js');assert.match(s,/createBusy/);assert.match(s,/finally\{createBusy=false;await loadOrderProviders\(\)\}/)});
