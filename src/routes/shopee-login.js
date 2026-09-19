import { auditAction } from "../middleware/console-audit.js";
import { Router } from 'express';
import { hasTerms } from './terms.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { startShopeeLogin, verifyShopeeLogin, finishShopeeLogin, cancelShopeeLogin, ShopeeLoginError } from '../services/shopee-login.js';

// Mount /api/accounts/shopee/login after session + cookie + CSRF middleware.
// POST start: {identifier,merchant_password,password,consent:true}; password reauthenticates PayGate.
// POST verify: {attempt_id,otp}. Either returns OTP or store DTO; no browser/provider credentials.
// POST finish: {attempt_id,choice,qris_static}; empty QR means use captured QR, never create one.
// POST cancel: {attempt_id}; always allowed without terms. No retry/resend/manual token import.
const router=Router();
router.use((req,res,next)=>{
  const event=req.method==='POST'?({'/start':'SHOPEE_LOGIN_START','/verify':'SHOPEE_LOGIN_VERIFY','/finish':'SHOPEE_LOGIN_FINISH','/cancel':'SHOPEE_LOGIN_CANCEL'}[req.path]):null;
  if(event)res.locals.consoleStage={'/start':'login_start','/verify':'login_verify','/finish':'merchant_save','/cancel':'login_cancel'}[req.path];
  auditAction(event)(req,res,next);
});
const limit=rateLimit({bucket:'shopee-browser-login',max:20,windowMs:900000});
const scrub=body=>{if(body && typeof body==='object') for(const key of ['password','merchant_password','otp','qris_static','token']) delete body[key];};
for(const [step,action] of Object.entries({start:startShopeeLogin,verify:verifyShopeeLogin,finish:finishShopeeLogin,cancel:cancelShopeeLogin})) {
  router.post('/'+step,(req,res,next)=>{
    res.set('Cache-Control','no-store');
    // Do not retain request passwords even when auth/terms/rate limiting short-circuits.
    if(!req.user || req.user.role!=='admin' || req.user.viaApiKey || !req.user.sid) {
      scrub(req.body); return res.status(403).json({error:'Sesi admin PayGate aktif diperlukan.',code:'FORBIDDEN'});
    }
    if(step!=='cancel' && !hasTerms(req)) {
      scrub(req.body); return res.status(403).json({error:'Baca dan setujui Syarat Penggunaan terlebih dahulu.',code:'TERMS_REQUIRED'});
    }
    if(step==='cancel') return next();
    // Rate limiter writes synchronously on denial; scrub then, not only on response completion.
    let allowed=false;
    limit(req,res,()=>{allowed=true;next();});
    if(!allowed) scrub(req.body);
  },async(req,res)=>{
    try {res.json(await action(req.user,req.body));}
    catch(error) {
      const safe=error instanceof ShopeeLoginError?error:new ShopeeLoginError('BAD_RESPONSE');
      const status={FORBIDDEN:403,INVALID:422,REAUTH:401,EXPIRED:410,BUSY:409,COOLDOWN:429,RATE_LIMITED:429,PROVIDER_COOLDOWN:429,SCOPE_CHANGED:409}[safe.code] || 503;
      if(safe.retryAt) res.set('Retry-After',String(Math.max(1,Math.ceil((safe.retryAt-Date.now())/1000))));
      res.status(status).json({error:safe.message,code:safe.code});
    } finally {scrub(req.body);}
  });
}
export default router;
