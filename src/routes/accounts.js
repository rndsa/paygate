import { auditAction } from "../middleware/console-audit.js";
import { Router } from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { asyncRoute } from '../lib/async.js';
import { LAB_PROVIDERS, getLabAccount, pollLabAccount, pauseLabAccount } from '../services/lab.js';
import { startLogin, verifyLogin, finishLogin, cancelLogin, MerchantLoginError, loginLogDetails } from '../services/login.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { hasTerms } from './terms.js';
import { shopeeBrowserAvailable } from '../services/shopee-login.js';
import { connectShopee, ShopeeConnectError } from '../services/shopee.js';
const router = Router();
router.use((req,res,next) => auditAction(req.method === 'POST' ? ({'/login/start':'GOPAY_LOGIN_START','/login/verify':'GOPAY_LOGIN_VERIFY','/login/finish':'GOPAY_LOGIN_FINISH','/login/cancel':'GOPAY_LOGIN_CANCEL','/test':'ACCOUNT_TEST','/resume':'ACCOUNT_RESUME','/pause':'ACCOUNT_PAUSE'}[req.path]) : req.method === 'DELETE' ? 'ACCOUNT_DELETE' : null)(req,res,next));
router.get('/', (req, res) => {
  // Refresh local expiry before constructing account DTO; never contacts provider.
  for (const provider of LAB_PROVIDERS) getLabAccount(provider, req.user.id);
  const accounts = db.prepare('SELECT provider,label,status,last_error,last_validated_at,created_at,updated_at,next_poll_at FROM payment_accounts WHERE user_id=? ORDER BY provider').all(req.user.id);
  res.json({ accounts, lab: { enabled: config.labUnofficialEnabled, owner: config.labUnofficialEnabled && req.user.id === config.labUserId,
    poll_interval_ms: config.labPollIntervalMs, providers: LAB_PROVIDERS.map(provider => {
      const row = getLabAccount(provider, req.user.id);
      return { provider, configured: Boolean(row), status: row?.status || 'unconfigured' };
    }) }, login: {
      gopay: { available: config.labUnofficialEnabled && req.user.id === config.labUserId, reason: 'Nomor telepon + OTP, lalu pilih merchant.' },
      shopeepay: { available: config.labUnofficialEnabled && req.user.id === config.labUserId && req.user.role === 'admin' && shopeeBrowserAvailable(), method: 'browser_password', reason: shopeeBrowserAvailable() ? 'Nomor/username/email + password Shopee melalui browser server. OTP bila diminta; CAPTCHA menghentikan proses.' : 'Login ShopeePay belum tersedia di server ini. Hubungi administrator untuk mengaktifkannya.' }
    }, connection: { shopeepay: { available: config.labUnofficialEnabled && req.user.id === config.labUserId, method: 'session_import' } } });
});
router.post('/', (req, res) => res.status(410).json({ error: 'Gunakan alur login merchant; impor token lewat API ini tidak didukung.' }));
router.post('/shopee/connect', rateLimit({bucket:'shopee-connect',max:10,windowMs:900000}), async (req,res) => {
  try {
    if (!hasTerms(req)) return res.status(403).json({error:'Baca dan setujui Syarat Penggunaan terlebih dahulu.',code:'TERMS_REQUIRED'});
    res.json(await connectShopee(req.user,req.body));
  } catch (error) {
    const safe = error instanceof ShopeeConnectError ? error : new ShopeeConnectError('SAVE_FAILED');
    const status={FORBIDDEN:403,INVALID:422,REAUTH:401,EXPIRED:410,COOLDOWN:429,PROVIDER_COOLDOWN:429,SCOPE_CHANGED:409}[safe.code] || 503;
    if (safe.retryAt) res.set('Retry-After',String(Math.max(1,Math.ceil((safe.retryAt-Date.now())/1000))));
    res.status(status).json({error:safe.message,code:safe.code});
  } finally { if (req.body) for (const key of ['token','password','qris_static']) delete req.body[key]; }
});
router.post(['/login/start','/login/verify','/login/finish','/test','/resume'], (req,res,next) => {
  if (!hasTerms(req)) return res.status(403).json({error:'Baca dan setujui Syarat Penggunaan terlebih dahulu.',code:'TERMS_REQUIRED'});
  next();
});
router.use('/login', rateLimit({bucket:'merchant-login',max:20,windowMs:900000}));
for (const [step, action] of Object.entries({start:startLogin,verify:verifyLogin,finish:finishLogin,cancel:cancelLogin})) {
  router.post(`/login/${step}`, async (req,res) => {
    try { res.json(await action(req.user,req.body)); }
    catch (error) {
      const stage = {start:'otp_request',verify:'otp_verify',finish:'merchant_discovery',cancel:'otp_request'}[step];
      const safe = error instanceof MerchantLoginError && error.diagnostic ? error :
        new MerchantLoginError(error instanceof MerchantLoginError ? error.code : 'BAD_RESPONSE', error instanceof MerchantLoginError ? error.retryAt : undefined, stage);
      const logDetails = loginLogDetails(safe);
      res.locals.consoleUpstreamCode = logDetails.upstream_code;
      res.locals.consoleUpstreamRequestId = logDetails.upstream_request_id;
      console.warn(JSON.stringify({...safe.diagnostic, ...logDetails}));
      const status = {FORBIDDEN:403,UNSUPPORTED:503,INVALID:422,REAUTH:401,COOLDOWN:429,RATE_LIMITED:429,EXPIRED:410,BUSY:409,SCOPE_CHANGED:409}[safe.code] || 503;
      if (safe.retryAt) res.set('Retry-After',String(Math.max(1,Math.ceil((safe.retryAt-Date.now())/1000))));
      res.status(status).json({error:safe.message,code:safe.code,diagnostic:safe.diagnostic});
    } finally { if (req.body) { delete req.body.phone; delete req.body.password; delete req.body.otp; } }
  });
}
router.post(['/test','/resume'], asyncRoute(async (req, res) => {
  if (!LAB_PROVIDERS.includes(req.body?.provider)) return res.status(422).json({ error: 'Provider invalid.' });
  if (!getLabAccount(req.body.provider, req.user.id)) return res.status(503).json({ error: 'Provider belum dikonfigurasi untuk user ini.' });
  const result = await pollLabAccount(req.body.provider, req.user.id, { test: true });
  if (!result.ok) {
    const rate = result.code === 'COOLDOWN';
    if (rate) res.set('Retry-After', String(Math.max(1, Math.ceil(((result.next_poll_at || Date.now()+60000)-Date.now())/1000))));
    return res.status(rate ? 429 : 503).json({ ...result, error: `${result.code}: polling berhenti. Periksa akun lewat portal resmi; jangan bypass challenge.` });
  }
  res.json(result);
}));
router.post('/pause', (req, res) => {
  if (!LAB_PROVIDERS.includes(req.body?.provider)) return res.status(422).json({ error: 'Provider invalid.' });
  if (!pauseLabAccount(req.body.provider, req.user.id)) return res.status(503).json({ error: 'Akun tidak tersedia.' });
  res.json({ ok: true, detail: 'Polling dijeda.' });
});
router.delete('/:provider', (req, res) => {
  if (!LAB_PROVIDERS.includes(req.params.provider)) return res.status(400).json({ error: 'Provider invalid.' });
  const account = db.prepare('SELECT id FROM payment_accounts WHERE user_id=? AND provider=?').get(req.user.id,req.params.provider);
  if (!account) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  // History must not lose its ownership/scope. Pause and remove env instead.
  if (db.prepare('SELECT 1 FROM orders WHERE account_id=? LIMIT 1').get(account.id) || db.prepare('SELECT 1 FROM seen_transactions WHERE account_id=? LIMIT 1').get(account.id)) return res.status(409).json({error:'Akun memiliki riwayat. Gunakan Pause lalu hapus token dari env.'});
  db.prepare('DELETE FROM payment_accounts WHERE id=?').run(account.id);
  res.json({ok:true});
});
export default router;
