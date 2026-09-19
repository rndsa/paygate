// Source-audited login integration, isolated DB + synthetic upstream. Never sends OTP.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=path.resolve(import.meta.dirname,'..'), temp=mkdtempSync(path.join(tmpdir(),'paygate-login-'));
let db;
const fetchLocal=globalThis.fetch;
globalThis.fetch=(url,...args)=>{
  assert.equal(new URL(url).hostname,'127.0.0.1','external fetch forbidden in isolated login tests');
  return fetchLocal(url,...args);
};
try {
  cpSync(path.join(root,'src'),path.join(temp,'src'),{recursive:true});
  symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'));
  Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(temp,'db'),PAYGATE_DATA_DIR:temp,ENCRYPTION_KEY:'aa'.repeat(32),COOKIE_SECRET:'22'.repeat(32),LAB_UNOFFICIAL:'1',LAB_USER_ID:'1',GOPAY_ACCESS_TOKEN:'',GOPAY_MERCHANT_ID:'',GOPAY_QRIS_STATIC:'',SHOPEEPAY_TOKEN:'',SHOPEEPAY_MERCHANT_ID:'',SHOPEEPAY_STORE_ID:'',SHOPEEPAY_QRIS_STATIC:''});
  const load=f=>import(pathToFileURL(path.join(temp,'src',f)));
  ({db}=await load('db/index.js'));
  const {hashPassword,decrypt}=await load('lib/crypto.js');
  const {config,getEncryptionKey}=await load('config.js');
  const password='Local-test-pass-123!', now=Date.now();
  for(const uid of [1,2]) {
    db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(uid,'user'+uid,await hashPassword(password),now,now);
    db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run('session'+uid,uid,now,now+600000);
  }
  const user={id:1,sid:'session1'}, body={provider:'gopay',phone:'081234567890',password,consent:true};
  const login=await load('services/login.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
  assert.equal(typeof login.startLogin,'function','direct login lifecycle must exist');
  let requests=[];
  const {crc16ccitt}=await load('lib/qris.js');
  const q='00020101021153033605802ID5911PAYGATE LAB6007JAKARTA6304', qr=q+crc16ccitt(q);
  const wire={fetch:async(url,init)=>{
    const u=new URL(url); requests.push({url:u.href,body:init.body&&JSON.parse(init.body),headers:init.headers});
    assert.equal(u.origin,'https://api.gobiz.co.id'); assert.equal(init.redirect,'manual');
    assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');
    const baseKeys=['Accept','Accept-Language','Authentication-Type','Content-Type','Gojek-Country-Code','Gojek-Timezone','Origin','Referer','User-Agent','X-AppId','X-AppVersion','X-DeviceOs','X-PhoneMake','X-PhoneModel','X-Platform','X-User-Locale','X-User-Type','x-uniqueid'];
    const isDiscovery=u.pathname==='/v1/merchants/search';
    // GoBiz /goid/* OTP endpoints carry NO Authorization (empty 'Bearer' -> HTTP 401);
    // only discovery sends a real Bearer token.
    assert.deepEqual(Object.keys(init.headers).sort(),(isDiscovery?[...baseKeys,'Authorization']:baseKeys).sort());
    // GoBiz /goid/* web-dashboard portal identity (owner-accepted full header emulation, 2026-09-09).
    assert.equal(init.headers['X-AppId'],'go-biz-web-dashboard');
    assert.equal(init.headers['X-Platform'],'Web');
    assert.equal(init.headers['Origin'],'https://portal.gofoodmerchant.co.id');
    assert.equal(init.headers['Referer'],'https://portal.gofoodmerchant.co.id/');
    assert.match(init.headers['User-Agent'],/^Mozilla\/5\.0 .*Chrome\/.*Safari/);
    assert.equal(init.headers['X-PhoneModel'],'Chrome 150.0.0.0 on Windows 10 64-bit');
    assert.equal(init.headers.Authorization,isDiscovery?'Bearer private-access':undefined);
    assert.equal(init.headers['x-uniqueid'],db.prepare('SELECT device_id FROM merchant_login_limits').get().device_id);
    const expected={
      '/goid/login/request':{client_id:'go-biz-web-new',phone_number:'81234567890',country_code:'62',login_type:'whatsapp'},
      '/goid/token':{client_id:'go-biz-web-new',data:{otp:'123456',otp_token:'private-challenge'},grant_type:'otp'},
      '/v1/merchants/search':{from:0,size:200,_source:['id','merchant_name','outlet_name','pops']},
    };
    assert.deepEqual(JSON.parse(init.body),expected[u.pathname],'pinned source-contract body unchanged');
    if(u.pathname==='/goid/login/request') return Response.json({success:true,data:{otp_token:'private-challenge'}});
    if(u.pathname==='/goid/token') return Response.json({access_token:'private-access',refresh_token:'private-refresh',token_type:'Bearer',expires_in:3600});
    if(u.pathname==='/v1/merchants/search') return Response.json({success:true,total:1,hits:[{id:'MERCHANT1',merchant_name:'Fixture Shop',outlet_name:'Fixture Outlet',pops:[{pop_id:'POP1',name:'Desk',gopay:{aspi_qr_string:qr}}]}]});
    throw new Error('Unexpected upstream path');
  }};
  const unlock=()=>db.prepare('UPDATE merchant_login_limits SET next_at=0,attempts=0,window_at=0').run();
  const diagnosticIds=new Set();
  const checkDiagnostics=(e,stage,status,code)=>{
    assert.ok(e.diagnostic,'sanitized diagnostic metadata missing');
    assert.deepEqual(Object.keys(e.diagnostic).sort(),['classification','id','provider_status','stage']);
    assert.equal(e.diagnostic.stage,stage);assert.equal(e.diagnostic.provider_status,status);
    assert.equal(e.diagnostic.classification,code);
    assert.match(e.diagnostic.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(!diagnosticIds.has(e.diagnostic.id),'diagnostic ID generated locally for each failure');
    diagnosticIds.add(e.diagnostic.id);
  };
  // Constructor is a closed vocabulary: local stages cannot inherit provider HTTP status.
  for (const stage of ['local_validation','reauth','cooldown','attempt_validation','otp_validation','merchant_selection','merchant_save']) {
    const error=new login.MerchantLoginError('INVALID',undefined,stage,201);
    checkDiagnostics(error,stage,null,'INVALID');
    assert.ok(Object.isFrozen(error.diagnostic));
    assert.throws(()=>{error.diagnostic.stage='otp_request';},TypeError);
  }
  for (const stage of ['NO-ECHO', '__proto__', {toString:()=>password}]) {
    const error=new login.MerchantLoginError('NO-ECHO',undefined,stage,200);
    checkDiagnostics(error,'local_validation',null,'BAD_RESPONSE');
    assert.ok(!JSON.stringify(error).includes('NO-ECHO'));assert.ok(!error.message.includes(password));
  }
  console.log('PASS diagnostic constructor: frozen closed stage vocabulary, local/unknown stages have null provider status');
  for (const [code,stage] of [['INVALID','local_validation'],['FORBIDDEN','local_validation'],['UNSUPPORTED','local_validation'],['COOLDOWN','cooldown'],['EXPIRED','attempt_validation'],['BUSY','attempt_validation'],['SCOPE_CHANGED','merchant_selection']]) {
    checkDiagnostics(new login.MerchantLoginError(code),stage,null,code);
  }
  // Native fetch must expose blocked redirects, not erase HTTP status as NETWORK.
  let redirectHits=0, targetHits=0;
  const redirectServer=createServer((req,res)=>{
    if(req.url==='/redirect') {redirectHits++;res.writeHead(302,{Location:'/target'});}
    else {targetHits++;res.writeHead(200);}
    res.end();
  });
  await new Promise(r=>redirectServer.listen(0,'127.0.0.1',r));
  try {
    await assert.rejects(login.startLogin(user,body,{fetch:(_url,init)=>fetch(`http://127.0.0.1:${redirectServer.address().port}/redirect`,init)}),e=>{
      assert.equal(e.code,'CHALLENGE','native 302 is blocked redirect, not network failure');
      checkDiagnostics(e,'otp_request',302,'CHALLENGE');
      return true;
    });
    assert.equal(redirectHits,1,'zero retries');assert.equal(targetHits,0,'redirect never followed');
  } finally {login.stopLogins();await new Promise(r=>redirectServer.close(r));unlock();}
  console.log('PASS native fetch 302 classified CHALLENGE; one request, no redirect follow');
  await assert.rejects(login.startLogin({id:2,sid:'session2'},body,wire),e=>e.code==='FORBIDDEN');
  await assert.rejects(login.startLogin(user,{...body,provider:'shopeepay'},wire),e=>e.code==='UNSUPPORTED');
  await assert.rejects(login.startLogin(user,{...body,phone:'garbage'},wire),e=>e.code==='INVALID');
  await assert.rejects(login.startLogin(user,{...body,consent:false},wire),e=>e.code==='INVALID');
  // OTP channel is user-selectable: whatsapp|sms. Default is whatsapp. Unknown values
  // are rejected locally without any upstream request.
  assert.equal(requests.length,0);
  await assert.rejects(login.startLogin(user,{...body,otp_channel:'telegram'},wire),e=>e.code==='INVALID');
  let waBody=null;
  await login.startLogin(user,{...body,otp_channel:'whatsapp'},{fetch:async(url,init)=>{if(new URL(url).pathname==='/goid/login/request')waBody=JSON.parse(init.body);return Response.json({success:true,data:{otp_token:'private-challenge'}});}});
  assert.equal(waBody.login_type,'whatsapp');
  unlock();
  let step=await login.startLogin(user,body,wire);
  assert.equal(step.step,'otp'); assert.ok(!JSON.stringify(step).includes('private'));
  assert.equal(requests[0].body.login_type,'whatsapp','default channel is whatsapp');
  assert.equal(requests[0].body.phone_number,'81234567890');
  await assert.rejects(login.startLogin(user,body,wire),e=>e.code==='COOLDOWN');
  await assert.rejects(login.verifyLogin({id:1,sid:'other'}, {provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},wire));
  const chosen=await login.verifyLogin(user,{provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},wire);
  assert.equal(chosen.step,'merchant'); assert.equal(chosen.merchants.length,1);
  assert.ok(!JSON.stringify(chosen).includes('private')); assert.ok(!JSON.stringify(chosen).includes(qr));
  assert.ok(!JSON.stringify(chosen).includes('MERCHANT1'),'merchant choices use opaque identifiers');
  await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},wire));
  const beforeSelection=requests.length, selectionLimits=db.prepare('SELECT * FROM merchant_login_limits').get();
  await assert.rejects(login.finishLogin(user,{provider:'gopay',attempt_id:step.attempt_id,merchant:'not-mine'}),e=>{
    checkDiagnostics(e,'merchant_selection',null,'INVALID');return e.code==='INVALID';
  });
  assert.equal(requests.length,beforeSelection,'local merchant selection never repeats discovery');
  assert.deepEqual(db.prepare('SELECT * FROM merchant_login_limits').get(),selectionLimits,'invalid selection preserves existing cooldown');
  // Real isolated SQLite failure: no synthetic provider or persistence exception may leak.
  const beforeSave=requests.length, saveLimits=db.prepare('SELECT * FROM merchant_login_limits').get();
  db.exec("CREATE TRIGGER reject_login_save BEFORE INSERT ON payment_accounts BEGIN SELECT RAISE(ABORT,'NO-ECHO private-access'); END");
  try {
    await assert.rejects(login.finishLogin(user,{provider:'gopay',attempt_id:step.attempt_id,merchant:chosen.merchants[0].id}),e=>{
      assert.equal(e.code,'SAVE_FAILED');checkDiagnostics(e,'merchant_save',null,'SAVE_FAILED');
      assert.ok(Object.isFrozen(e.diagnostic));
      assert.ok(!e.message.includes('Respons'));assert.ok(!e.message.includes('NO-ECHO'));
      assert.ok(!JSON.stringify(e).includes('private-access'));return true;
    });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_accounts').get().n,0,'failed insert leaves no partial account');
    assert.deepEqual(db.prepare('SELECT * FROM merchant_login_limits').get(),saveLimits,'save failure preserves existing cooldown');
    assert.equal(requests.length,beforeSave,'saving never makes provider calls');
  } finally {db.exec('DROP TRIGGER reject_login_save');}
  console.log('PASS real SQLite save failure is SAVE_FAILED/merchant_save/null; no raw error, partial insert or provider calls');
  // Bad selection/save must not invalidate otherwise unchanged authenticated attempt.
  const done=await login.finishLogin(user,{provider:'gopay',attempt_id:step.attempt_id,merchant:chosen.merchants[0].id});
  assert.equal(done.ok,true);
  const account=db.prepare("SELECT * FROM payment_accounts WHERE provider='gopay'").get();
  assert.equal(account.status,'configured'); assert.equal(account.credential_source,'dashboard');
  assert.equal(account.last_validated_at,null); assert.ok(!account.credential.includes('private-access'));
  const c=JSON.parse(decrypt(account.credential,getEncryptionKey()));
  assert.equal(c.access_token,'private-access'); assert.equal(c.merchant_id,'MERCHANT1');
  assert.ok(!JSON.stringify(c).includes(password)); assert.ok(!JSON.stringify(c).includes('123456'));
  const lab=await load('services/lab.js');
  lab.syncLabAccounts(); assert.ok(lab.getLabAccount('gopay',1),'env absence cannot disable dashboard token');
  lab.pauseLabAccount('gopay',1); lab.syncLabAccounts(); assert.equal(lab.getLabAccount('gopay',1).status,'paused');
  await assert.rejects(login.finishLogin(user,{provider:'gopay',attempt_id:step.attempt_id,merchant:chosen.merchants[0].id}));
  assert.equal(c.outlet_id,'POP1','selected outlet must persist');
  db.prepare('INSERT INTO seen_transactions(provider,txid,account_id,amount,tx_time,seen_at) VALUES(?,?,?,?,?,?)').run('gopay','scope-history',account.id,1,now,now);
  const changedWire={fetch:async(url,init)=>{
    const r=await wire.fetch(url,init);
    if(new URL(url).pathname!=='/v1/merchants/search') return r;
    const value=await r.json();value.hits[0].pops[0].pop_id='POP2';return Response.json(value);
  }};
  unlock();step=await login.startLogin(user,body,changedWire);
  const changed=await login.verifyLogin(user,{provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},changedWire);
  await assert.rejects(login.finishLogin(user,{provider:'gopay',attempt_id:step.attempt_id,merchant:changed.merchants[0].id}),e=>e.code==='SCOPE_CHANGED');
  assert.equal(JSON.parse(decrypt(lab.getLabAccount('gopay',1).credential,getEncryptionKey())).outlet_id,'POP1');
  login.cancelLogin(user,{provider:'gopay',attempt_id:step.attempt_id});
  unlock();step=await login.startLogin(user,body,wire);
  await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},{fetch:async(url,init)=>{
    const r=await wire.fetch(url,init);if(new URL(url).pathname!=='/v1/merchants/search')return r;
    const value=await r.json();value.hits[0].pops.push({pop_id:'POP2'});return Response.json(value);
  }}),e=>e.code==='MULTI_OUTLET');
  console.log('PASS source-contract OTP/discovery/selection, immutable single-outlet scope, encrypted dashboard session, no automatic activation');
  unlock();
  const beforeReauth=requests.length, reauthAt=Date.now();
  await assert.rejects(login.startLogin(user,{...body,password:'wrong-password'},wire),e=>{
    checkDiagnostics(e,'reauth',null,'REAUTH');
    assert.ok(Object.isFrozen(e.diagnostic));
    assert.ok(!e.message.includes('OTP'));assert.ok(!JSON.stringify(e).includes('wrong-password'));
    return e.code==='REAUTH';
  });
  assert.equal(requests.length,beforeReauth,'wrong PayGate password makes zero OTP requests');
  assert.ok(db.prepare('SELECT next_at FROM merchant_login_limits').get().next_at>=reauthAt+900000);
  await assert.rejects(login.startLogin(user,body,wire),e=>e.code==='COOLDOWN');
  assert.equal(requests.length,beforeReauth,'reauth cooldown is durable and blocks requests');
  console.log('PASS wrong PayGate password is local reauth/null; zero OTP requests, sanitized error, durable cooldown');
  unlock();
  await assert.rejects(login.startLogin(user,body,{fetch:async()=>Response.json({captcha_required:true,secret:'NO-ECHO'})}),e=>e.code==='CHALLENGE'&&!e.message.includes('NO-ECHO'));
  assert.ok(db.prepare('SELECT next_at FROM merchant_login_limits').get().next_at>Date.now()+800000);
  unlock();
  await assert.rejects(login.startLogin(user,body,{fetch:async()=>Response.json({secret:'NO-ECHO'},{status:429,headers:{'Retry-After':'1200'}})}),e=>e.code==='RATE_LIMITED');
  assert.ok(db.prepare('SELECT next_at FROM merchant_login_limits').get().next_at>Date.now()+1100000);
  unlock();
  await assert.rejects(login.startLogin(user,body,{fetch:async()=>Response.json({success:true,data:{}})}),e=>e.code==='BAD_RESPONSE');
  unlock();
  step=await login.startLogin(user,body,wire);
  login.cancelLogin(user,{provider:'gopay',attempt_id:step.attempt_id});
  await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},wire));
  unlock(); step=await login.startLogin(user,body,wire);
  db.prepare('DELETE FROM sessions WHERE id=?').run(user.sid);
  await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},wire));
  login.stopLogins();
  console.log('PASS challenge/rate/schema fail closed, durable cooldown, reauth, cancel/logout invalidate attempts');
  db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(user.sid,1,Date.now(),Date.now()+600000);
  unlock();
  db.prepare('UPDATE merchant_login_limits SET attempts=5,window_at=?').run(Date.now());
  await assert.rejects(login.startLogin(user,body,wire),e=>e.code==='COOLDOWN');
  // Synthetic status matrix: classification is not evidence of a live provider root cause.
  const failureCase=async(makeResponse,code)=>{
    unlock(); let calls=0; const before=Date.now();
    let expectedStatus=null;
    const transport={fetch:async()=>{calls++;const r=await makeResponse();if(r instanceof Response) expectedStatus=r.status || null;return r;}};
    await assert.rejects(login.startLogin(user,body,transport),e=>{
      assert.ok(e instanceof login.MerchantLoginError);
      assert.equal(e.code,code);
      assert.deepEqual(Object.keys(e).sort(),['code','diagnostic','retryAt']);
      checkDiagnostics(e,'otp_request',expectedStatus,code);
      for(const secret of ['NO-ECHO',password,body.phone,'private-access','private-refresh','private-challenge']) {
        assert.ok(!JSON.stringify(e).includes(secret)); assert.ok(!e.message.includes(secret));
      }
      assert.ok(e.retryAt>=before+900000);
      return true;
    });
    assert.equal(calls,1,'failed authentication never retries');
    assert.ok(db.prepare('SELECT next_at FROM merchant_login_limits').get().next_at>=before+900000);
    await assert.rejects(login.startLogin(user,body,transport),e=>e.code==='COOLDOWN');
    assert.equal(calls,1,'cooldown blocks new upstream requests');
  };
  // Pinned authClient.ts assertSuccess distinguishes explicit unsuccessful OTP envelope.
  await failureCase(()=>Response.json({success:false,data:null,errors:[{code:'NO-ECHO',message:password}]}),'BUSINESS_REJECTED');
  await failureCase(()=>Response.json({success:false,captcha_required:true,errors:[{code:'NO-ECHO'}]}),'CHALLENGE');
  await failureCase(()=>Response.json({success:true,data:{}}),'BAD_RESPONSE');
  console.log('PASS explicit OTP success:false is BUSINESS_REJECTED; challenge takes precedence; missing token stays BAD_RESPONSE');
  for(const status of [500,502,503,504]) await failureCase(()=>new Response('NO-ECHO',{status}),'PROVIDER_ERROR');
  for(const status of [400,404,405,408,409,422]) await failureCase(()=>Response.json({secret:'NO-ECHO'},{status}),'REQUEST_REJECTED');
  for(const status of [401,403]) await failureCase(()=>Response.json({secret:'NO-ECHO'},{status}),'AUTH_REJECTED');
  for(const requestId of ['NO-ECHO', '12345678-1234-4234-8234-123456789abc']) {
    await failureCase(()=>Response.json({errors:[{code:'NO-ECHO',message:password}]},{status:401,headers:{'X-Request-ID':requestId,'Request-ID':requestId,'Set-Cookie':'NO-ECHO'}}),'AUTH_REJECTED');
  }
  // GoBiz phone-rejection: classified by upstream enum code only; message/title never echoed.
  await failureCase(()=>Response.json({data:null,success:false,errors:[{code:'goid:error:unauthorized',message:'NO-ECHO',message_title:'NO-ECHO'}]},{status:401}),'PHONE_REJECTED');
  const unauthorized={data:null,success:false,errors:[{code:'goid:error:unauthorized',message:'NO-ECHO',message_title:'NO-ECHO'}]};
  for (const envelope of [{...unauthorized,success:true},{...unauthorized,data:{}},{...unauthorized,errors:[...unauthorized.errors,{code:'goid:error:secret_NO-ECHO'}]}])
    await failureCase(()=>Response.json(envelope,{status:401}),'AUTH_REJECTED');
  await failureCase(()=>Response.json(unauthorized,{status:403}),'AUTH_REJECTED');
  await failureCase(()=>Response.json({...unauthorized,captcha_required:true},{status:401}),'CHALLENGE');
  await failureCase(()=>Response.json(unauthorized,{status:429}),'RATE_LIMITED');
  // Specific enum remains generic during OTP verification and merchant discovery.
  for(const stage of ['otp_verify','merchant_discovery']) {
    unlock(); const attempt=await login.startLogin(user,body,wire); let calls=0;
    await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:attempt.attempt_id,otp:'123456'},{fetch:async(url,init)=>{
      calls++;if(stage==='merchant_discovery'&&new URL(url).pathname==='/goid/token')return wire.fetch(url,init);
      return Response.json(unauthorized,{status:401});
    }}),error=>{checkDiagnostics(error,stage,401,'AUTH_REJECTED');assert.deepEqual(login.loginLogDetails(error),{});return true;});
    assert.equal(calls,stage==='otp_verify'?1:2);
  }
  // A PII/secret-shaped request header is discarded; only the known enum can be logged.
  unlock();
  await assert.rejects(login.startLogin(user,body,{fetch:async()=>Response.json(unauthorized,{status:401,headers:{'Request-ID':body.phone}})}),error=>{
    assert.equal(error.code,'PHONE_REJECTED');assert.equal(login.loginLogDetails(error).upstream_request_id,null);
    assert.ok(!JSON.stringify(login.loginLogDetails(error)).includes(body.phone));return true;
  });
  // Non-matching enum at 401 stays generic AUTH_REJECTED.
  await failureCase(()=>Response.json({data:null,success:false,errors:[{code:'goid:error:other',message:'NO-ECHO'}]},{status:401}),'AUTH_REJECTED');
  await failureCase(()=>({status:403,secret:'NO-ECHO'}),'BAD_RESPONSE');
  await failureCase(()=>Response.error(),'REQUEST_REJECTED');
  console.log('PASS synthetic HTTP 5xx/provider, other non-auth rejection, 401/403/auth; no secrets, retries, or cooldown bypass');
  for(const marker of ['{"challenge_required":true,"secret":"NO-ECHO"}', '<html>hcaptcha NO-ECHO</html>', 'device verification NO-ECHO']) {
    await failureCase(()=>new Response(marker,{status:403}),'CHALLENGE');
  }
  await failureCase(()=>new Response(null,{status:403}),'AUTH_REJECTED');
  await failureCase(()=>new Response(null,{status:503}),'PROVIDER_ERROR');
  let boundedReads=0, boundedCancelled=false;
  await failureCase(()=>new Response(new ReadableStream({pull(c){boundedReads++;c.enqueue(new Uint8Array(600000));},cancel(){boundedCancelled=true;}}),{status:403}),'BAD_RESPONSE');
  assert.ok(boundedReads<=3,'challenge inspection stays bounded'); assert.equal(boundedCancelled,true);
  await failureCase(()=>new Response('captcha_required NO-ECHO',{status:403,headers:{'Content-Length':'1048577'}}),'BAD_RESPONSE');
  console.log('PASS synthetic 403 JSON/HTML/device challenges, empty 403/503, bounded challenge body');
  for(const text of ['{NO-ECHO', '<html>NO-ECHO</html>', '', 'null', '[]']) await failureCase(()=>new Response(text),'BAD_RESPONSE');
  await failureCase(()=>new Response(Uint8Array.of(0xc3,0x28)),'BAD_RESPONSE');
  await failureCase(()=>{throw new TypeError('NO-ECHO');},'NETWORK');
  await failureCase(()=>new Response(new ReadableStream({start(c){c.error(new Error('NO-ECHO'));}})),'NETWORK');
  for(const status of [300,301,302,303,304,305,307,308,399]) await failureCase(()=>new Response(null,{status,headers:{Location:'https://example.invalid/NO-ECHO'}}),'CHALLENGE');
  console.log('PASS synthetic malformed JSON/UTF-8/schema is BAD_RESPONSE, transport failure is NETWORK, redirects stop');
  const nativeSetTimeout=globalThis.setTimeout; let expireRequest;
  try {
    // Fire request deadline deterministically; no real network or 15-second wait.
    globalThis.setTimeout=(fn,ms,...args)=>{if(ms===15000) expireRequest=fn;return nativeSetTimeout(fn,ms,...args);};
    await failureCase(()=>{queueMicrotask(()=>expireRequest());return new Promise(()=>{});},'NETWORK');
  } finally {globalThis.setTimeout=nativeSetTimeout;}
  console.log('PASS request timeout is NETWORK, not session EXPIRED; no retry');
  await failureCase(()=>new Response('NO-ECHO',{status:429,headers:{'Retry-After':'1200'}}),'RATE_LIMITED');
  for(const [status,text,code] of [[503,'NO-ECHO','PROVIDER_ERROR'],[401,'NO-ECHO','AUTH_REJECTED'],[403,'hcaptcha NO-ECHO','CHALLENGE'],[200,'{NO-ECHO','BAD_RESPONSE']]) {
    unlock(); const attempt=await login.startLogin(user,body,wire); let calls=0;
    const otpBody={provider:'gopay',attempt_id:attempt.attempt_id,otp:'123456'};
    const transport={fetch:async(url)=>{calls++;assert.equal(new URL(url).pathname,'/goid/token');return new Response(text,{status});}};
    await assert.rejects(login.verifyLogin(user,otpBody,transport),e=>{checkDiagnostics(e,'otp_verify',status,code);return e.code===code&&!e.message.includes('NO-ECHO');});
    await assert.rejects(login.verifyLogin(user,otpBody,transport),e=>e.code==='EXPIRED');
    await assert.rejects(login.startLogin(user,body,transport),e=>e.code==='COOLDOWN');
    assert.equal(calls,1,'OTP failure drops attempt, never retries or starts merchant discovery');
  }
  console.log('PASS synthetic OTP provider/auth/challenge/JSON failures drop attempts; no resend/discovery, cooldown retained');
  // Request context survives later semantic validation; new stage resets prior status.
  for(const [stage,makeResponse,code,status] of [
    ['otp_verify',()=>Response.json({expires_in:3600,secret:'NO-ECHO'},{status:201}),'BAD_RESPONSE',201],
    ['merchant_discovery',()=>Response.json({success:true,hits:'NO-ECHO'}),'BAD_RESPONSE',200],
    ['merchant_discovery',()=>Response.json({success:true,hits:[]}),'NO_MERCHANT',200],
    ['merchant_discovery',()=>Response.json({success:true,hits:[{id:'M1',pops:[{},{}]}]}),'MULTI_OUTLET',200],
    ['merchant_discovery',()=>new Response('NO-ECHO',{status:503}),'PROVIDER_ERROR',503],
    ['merchant_discovery',()=>{throw new Error('NO-ECHO');},'NETWORK',null],
  ]) {
    unlock();const attempt=await login.startLogin(user,body,wire);let calls=0;
    await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:attempt.attempt_id,otp:'123456'},{fetch:async(url,init)=>{
      calls++;
      if(stage==='merchant_discovery' && new URL(url).pathname==='/goid/token') return wire.fetch(url,init);
      return makeResponse();
    }}),e=>{checkDiagnostics(e,stage,status,code);return e.code===code&&!JSON.stringify(e).includes('NO-ECHO');});
    assert.equal(calls,stage==='otp_verify'?1:2);
    assert.ok(db.prepare('SELECT next_at FROM merchant_login_limits').get().next_at>Date.now()+800000);
  }
  console.log('PASS stage/status survive OTP token and merchant schema validation; discovery network failure resets status to null');
  // Regression: live GoID answers 201 with token_type "GoBearer" (audited authClient.test.ts),
  // and the token contract treats expires_in as optional (defaults ~30 min). The pinned success
  // path must accept both; the scheme stays unused downstream (discovery sends plain Bearer).
  for(const [name,payload,expiresIn] of [
    ['GoBearer',{access_token:'private-access',refresh_token:'private-refresh',token_type:'GoBearer',expires_in:3600},3600],
    ['omitted expires_in',{access_token:'private-access',refresh_token:'private-refresh',token_type:'GoBearer'},1800],
  ]) {
    unlock();
    const attempt=await login.startLogin(user,body,wire);
    const result=await login.verifyLogin(user,{provider:'gopay',attempt_id:attempt.attempt_id,otp:'123456'},{fetch:async(url,init)=>{
      if(new URL(url).pathname==='/goid/token') return Response.json(payload,{status:201});
      return wire.fetch(url,init);
    }});
    assert.equal(result.step,'merchant',name);
    const finish=await login.finishLogin(user,{provider:'gopay',attempt_id:attempt.attempt_id,merchant:result.merchants[0].id});
    assert.equal(finish.ok,true,name);
    const saved=JSON.parse(decrypt(db.prepare("SELECT credential FROM payment_accounts WHERE provider='gopay'").get().credential,getEncryptionKey()));
    assert.equal(saved.access_token,'private-access',name);
    assert.ok(Number.isSafeInteger(saved.expires_at)&&saved.expires_at>Date.now(),name);
    assert.ok(Math.abs((saved.expires_at-Date.now())-expiresIn*1000)<5000,`${name}: expiry derived from ${expiresIn}s`);
  }
  console.log('PASS live GoBearer token_type and omitted expires_in accepted; access token still stored');
  // Fail-closed: the relaxed scheme check still rejects non-string/oversized token_type,
  // a non-integer expires_in and a missing access token.
  for(const [payload,label] of [
    [{access_token:'private-access',token_type:'Go Bearer!',expires_in:3600},'space/punctuation scheme'],
    [{access_token:'private-access',token_type:'A'.repeat(25),expires_in:3600},'oversized scheme'],
    [{access_token:'private-access',token_type:'GoBearer',expires_in:'3600'},'string expires_in'],
    [{refresh_token:'private-refresh',token_type:'GoBearer',expires_in:3600},'missing access_token'],
  ]) {
    unlock(); const attempt=await login.startLogin(user,body,wire);
    await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:attempt.attempt_id,otp:'123456'},{fetch:async(url,init)=>{
      if(new URL(url).pathname==='/goid/token') return Response.json(payload,{status:201});
      return wire.fetch(url,init);
    }}),e=>{checkDiagnostics(e,'otp_verify',201,'BAD_RESPONSE');return e.code==='BAD_RESPONSE';},label);
  }
  console.log('PASS malformed token scheme/expiry/missing token still BAD_RESPONSE');
  unlock();
  // Cancel while a non-cooperative upstream ignores AbortSignal: no stale attempt survives.
  step=await login.startLogin(user,body,wire);
  let release, entered;
  const gate=new Promise(r=>entered=r);
  const pending=login.verifyLogin(user,{provider:'gopay',attempt_id:step.attempt_id,otp:'123456'},{fetch:()=>{entered();return new Promise(r=>release=r);}});
  await gate;
  login.cancelLogin(user,{provider:'gopay',attempt_id:step.attempt_id});
  await assert.rejects(pending,e=>{checkDiagnostics(e,'otp_verify',null,'EXPIRED');return e.code==='EXPIRED';});
  release(Response.json({access_token:'must-not-survive'}));
  unlock();
  // Real Express routing, real session middleware and CSRF. Only upstream transport is synthetic.
  const express=(await import(path.join(root,'node_modules/express/index.js'))).default;
  const security=await load('middleware/security.js'), accounts=(await load('routes/accounts.js')).default;
  let clearedBody;
  const app=express(); app.use(express.json());
  // Distinct local test client gives the added log scenario its own rate bucket.
  app.use((req,res,next)=>{if(req.get('X-Test-Client')==='phone-log') Object.defineProperty(req,'ip',{value:'127.0.0.2'});next();});
  app.use((req,res,next)=>{res.once('finish',()=>{clearedBody={...req.body};});next();});
  app.use(security.parseCookies); app.use(security.sessionMiddleware); app.use(security.csrf); app.use(security.requireAuth); app.use('/api/accounts',accounts);
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const nativeFetch=globalThis.fetch, nativeWarn=console.warn, diagnosticLogs=[];
  const {TERMS_VERSION}=await load('routes/terms.js');
  const signedTerms=version=>{
    const payload=`${version}.${Date.now()+86400000}`;
    return `paygate_terms=${payload}.${createHmac('sha256',config.cookieSecret).update(`paygate:terms:${payload}`).digest('hex')}`;
  };
  const termsCookie=signedTerms(TERMS_VERSION);
  const invalidTerms=['',signedTerms('2026-09-08'),termsCookie.slice(0,-1)+(termsCookie.endsWith('0')?'1':'0')];
  const api=async(route,body,csrf=true,sid='session1',terms=termsCookie,testClient='')=>{
    const r=await nativeFetch(`http://127.0.0.1:${server.address().port}/api/accounts`+route,{method:body?'POST':'GET',headers:{'X-Test-Client':testClient,Cookie:`paygate_sid=${sid}; paygate_csrf=0123456789abcdef0123456789abcdef; ${terms}`,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':'0123456789abcdef0123456789abcdef'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'});
    return {status:r.status,data:await r.json()};
  };
  try {
    console.warn=(...args)=>{assert.equal(args.length,1);diagnosticLogs.push(JSON.parse(args[0]));};
    globalThis.fetch=wire.fetch;
    const requiresTerms=async(route,input)=>{
      const before=requests.length;
      const accountsBefore=db.prepare('SELECT * FROM payment_accounts').all();
      const limitsBefore=db.prepare('SELECT * FROM merchant_login_limits').all();
      for (const terms of invalidTerms) {
        const rejected=await api(route,input,true,'session1',terms);
        assert.equal(requests.length,before,`${route}: rejected consent must make zero provider calls`);
        assert.deepEqual(rejected,{status:403,data:{error:'Baca dan setujui Syarat Penggunaan terlebih dahulu.',code:'TERMS_REQUIRED'}});
        assert.deepEqual(db.prepare('SELECT * FROM payment_accounts').all(),accountsBefore);
        assert.deepEqual(db.prepare('SELECT * FROM merchant_login_limits').all(),limitsBefore);
      }
    };
    const beforeCalls=requests.length;
    for (const terms of invalidTerms) assert.equal((await api('',undefined,true,'session1',terms)).status,200);
    assert.equal((await api('')).data.login.gopay.available,true);
    assert.equal((await api('',undefined,true,'session2')).data.login.gopay.available,false);
    assert.equal(requests.length,beforeCalls,'GET never contacts merchant');
    assert.equal((await api('/login/start',body,false)).status,403);
    assert.equal((await api('/login/start',body,true,'session2')).status,403);
    assert.equal(requests.length,beforeCalls);
    await requiresTerms('/login/start',body);
    const start=await api('/login/start',body); assert.equal(start.status,200); assert.equal(start.data.step,'otp');
    const otpBody={provider:'gopay',attempt_id:start.data.attempt_id,otp:'123456'};
    await requiresTerms('/login/verify',otpBody);
    const beforeInvalidOtp=requests.length;
    await assert.rejects(login.verifyLogin(user,{...otpBody,otp:'NO-ECHO'},wire),e=>{
      checkDiagnostics(e,'otp_validation',null,'INVALID');return e.code==='INVALID';
    });
    assert.equal(requests.length,beforeInvalidOtp,'invalid OTP is local and leaves the attempt usable');
    const verify=await api('/login/verify',otpBody); assert.equal(verify.status,200);
    const finishBody={provider:'gopay',attempt_id:start.data.attempt_id,merchant:verify.data.merchants[0].id};
    await requiresTerms('/login/finish',finishBody);
    const finish=await api('/login/finish',finishBody); assert.equal(finish.status,200);
    for (const terms of invalidTerms) {
      unlock(); const attempt=await login.startLogin(user,body,wire), before=requests.length;
      assert.deepEqual(await api('/login/cancel',{provider:'gopay',attempt_id:attempt.attempt_id},true,'session1',terms),{status:200,data:{ok:true}});
      await assert.rejects(login.verifyLogin(user,{provider:'gopay',attempt_id:attempt.attempt_id,otp:'123456'},wire),e=>e.code==='EXPIRED');
      assert.equal(requests.length,before,'cancel needs no current consent and makes zero provider calls');
    }
    console.log('PASS HTTP login consent: missing/old/corrupt rejected before provider or state changes; current accepted; cancel/read remain accessible');
    const dto=JSON.stringify((await api('')).data);
    for(const secret of [password,'private-access','private-refresh','private-challenge',qr]) assert.ok(!dto.includes(secret));
    assert.equal(lab.getLabAccount('gopay',1).status,'configured');
    console.log('PASS real HTTP login routes, CSRF, owner denial, no GET upstream, DTO has no credentials');
    for(const [status,text,code] of [
      [503,'NO-ECHO','PROVIDER_ERROR'],[422,'NO-ECHO','REQUEST_REJECTED'],
      [401,'NO-ECHO','AUTH_REJECTED'],[403,'{"captcha_required":true,"secret":"NO-ECHO"}','CHALLENGE'],
      [200,'{NO-ECHO','BAD_RESPONSE'],[200,'{"success":false,"data":null,"errors":[{"code":"NO-ECHO"}]}','BUSINESS_REJECTED'],
    ]) {
      unlock(); let calls=0;
      globalThis.fetch=async()=>{calls++;return new Response(text,{status,headers:{'X-Request-ID':'NO-ECHO','Set-Cookie':'NO-ECHO'}});};
      const beforeLogs=diagnosticLogs.length;
      const rejected=await api('/login/start',body);
      assert.equal(rejected.status,503); assert.equal(rejected.data.code,code);
      assert.deepEqual(Object.keys(rejected.data).sort(),['code','diagnostic','error']);
      checkDiagnostics(rejected.data,'otp_request',status,code);
      assert.equal(diagnosticLogs.length,beforeLogs+1,'one structured log per login failure');
      assert.deepEqual(diagnosticLogs.at(-1),rejected.data.diagnostic,'same safe metadata in API and log');
      assert.ok(!Object.hasOwn(clearedBody,'password'));assert.ok(!Object.hasOwn(clearedBody,'otp'));
      assert.ok(!Object.hasOwn(clearedBody,'phone'),'raw phone cleared after API failure');
      assert.equal(rejected.data.error,new login.MerchantLoginError(code).message);
      for(const secret of ['NO-ECHO',password,body.phone,'private-access','private-challenge']) assert.ok(!JSON.stringify(rejected.data).includes(secret));
      assert.equal(calls,1);
      const cooldown=await api('/login/start',body);
      assert.equal(cooldown.data.code,'COOLDOWN');checkDiagnostics(cooldown.data,'cooldown',null,'COOLDOWN');
      assert.equal(diagnosticLogs.length,beforeLogs+2);assert.deepEqual(diagnosticLogs.at(-1),cooldown.data.diagnostic);
      assert.equal(calls,1);
    }
    // A recognized GoBiz phone rejection shows actionable client copy and emits exactly one
    // enriched, secret-free JSON log for developers. Raw upstream message/title never escape.
    unlock();
    const phoneRequestId='42c74298-c38d-4137-900e-3700cb390fe3';
    globalThis.fetch=async()=>Response.json({data:null,success:false,errors:[{code:'goid:error:unauthorized',message:'NO-ECHO',message_title:'NO-ECHO'}]},{status:401,headers:{'Request-ID':phoneRequestId,'Set-Cookie':'NO-ECHO'}});
    const beforePhoneLogs=diagnosticLogs.length;
    const phoneRejected=await api('/login/start',body,true,'session1',termsCookie,'phone-log');
    assert.equal(phoneRejected.status,503);assert.equal(phoneRejected.data.code,'PHONE_REJECTED');
    assert.equal(phoneRejected.data.error,new login.MerchantLoginError('PHONE_REJECTED').message);
    checkDiagnostics(phoneRejected.data,'otp_request',401,'PHONE_REJECTED');
    assert.equal(diagnosticLogs.length,beforePhoneLogs+1,'phone rejection emits exactly one structured log');
    const phoneLog=diagnosticLogs.at(-1);
    assert.deepEqual(Object.keys(phoneLog).sort(),['classification','event','id','provider_status','stage','upstream_codes','upstream_request_id']);
    assert.equal(phoneLog.event,'gopay_otp_request_phone_rejected');
    assert.deepEqual(phoneLog.upstream_codes,['goid:error:unauthorized']);
    assert.equal(phoneLog.upstream_request_id,phoneRequestId);
    assert.ok(!JSON.stringify(phoneRejected.data).includes(phoneRequestId));
    assert.equal(phoneLog.id,phoneRejected.data.diagnostic.id);
    for(const secret of ['NO-ECHO',password,body.phone,'private-access','private-challenge']) assert.ok(!JSON.stringify(phoneRejected.data).includes(secret)&&!JSON.stringify(phoneLog).includes(secret));
    console.log('PASS real HTTP safe diagnostic metadata, one enriched JSON log, cleared raw fields, provider/request/auth/challenge/JSON/business failures');
    // Verify route exposes later response-validation metadata, not stale OTP request status.
    unlock();const diagnosticAttempt=await login.startLogin(user,body,wire);let verifyCalls=0;
    globalThis.fetch=async(url,init)=>{
      verifyCalls++;
      if(new URL(url).pathname==='/goid/token') return wire.fetch(url,init);
      return Response.json({success:true,hits:'NO-ECHO'},{status:201});
    };
    const beforeVerifyLogs=diagnosticLogs.length;
    const badDiscovery=await api('/login/verify',{provider:'gopay',attempt_id:diagnosticAttempt.attempt_id,otp:'123456'});
    assert.equal(badDiscovery.status,503);assert.equal(verifyCalls,2);
    checkDiagnostics(badDiscovery.data,'merchant_discovery',201,'BAD_RESPONSE');
    assert.equal(diagnosticLogs.length,beforeVerifyLogs+1);
    assert.deepEqual(diagnosticLogs.at(-1),badDiscovery.data.diagnostic);
    assert.ok(!Object.hasOwn(clearedBody,'otp'));
    for(const entry of diagnosticLogs) {
      assert.deepEqual(Object.keys(entry).sort(),entry.classification === 'PHONE_REJECTED' ? ['classification','event','id','provider_status','stage','upstream_codes','upstream_request_id'] : ['classification','id','provider_status','stage']);
      for(const secret of ['NO-ECHO',password,body.phone,'123456','private-access','private-refresh','private-challenge']) {
        // UUID is random; inspect metadata fields other than the independently validated ID.
        assert.ok(!JSON.stringify({...entry,id:undefined}).includes(secret));
      }
    }
    console.log('PASS HTTP discovery schema diagnostic, local cooldown status null, no duplicate logs or raw OTP');
    const {encrypt}=await load('lib/crypto.js');
    const expired=JSON.parse(decrypt(lab.getLabAccount('gopay',1).credential,getEncryptionKey()));expired.expires_at=Date.now()-1000;
    db.prepare("UPDATE payment_accounts SET credential=?,status='active',last_validated_at=?,next_poll_at=0 WHERE provider='gopay'").run(encrypt(JSON.stringify(expired),getEncryptionKey()),Date.now());
    let feedCalls=0; const fakeFeed={fetch:async()=>{feedCalls++;return Response.json({from:0,size:100,total:0,transactions:[]});}};
    const expiredRaw=db.prepare("SELECT * FROM payment_accounts WHERE provider='gopay'").get();
    const {getProviderFor}=await load('services/provider.js');
    await assert.rejects(getProviderFor('gopay',fakeFeed).getTransactions(expiredRaw,getEncryptionKey(),Date.now()-60000),e=>e.code==='AUTH_REJECTED');
    const metadata=(await api('')).data;
    assert.equal(metadata.accounts[0].status,'blocked');assert.equal(metadata.accounts[0].last_validated_at,null);
    assert.equal(metadata.lab.providers[0].status,'blocked');
    assert.equal(lab.getLabAccount('gopay',1).status,'blocked');
    assert.equal((await lab.pollLabAccount('gopay',1,{test:true,...fakeFeed})).ok,false);
    assert.equal(feedCalls,0,'known-expired token never sent upstream');
    app.use('/api/orders',(await load('routes/orders.js')).default);
    const rejected=await nativeFetch(`http://127.0.0.1:${server.address().port}/api/orders/create`,{method:'POST',headers:{Cookie:'paygate_sid=session1; paygate_csrf=0123456789abcdef0123456789abcdef','X-CSRF-Token':'0123456789abcdef0123456789abcdef','Content-Type':'application/json'},body:JSON.stringify({provider:'gopay',amount:12345})});
    assert.equal(rejected.status,503);assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n,0);
    assert.equal(db.prepare("SELECT last_validated_at FROM payment_accounts WHERE provider='gopay'").get().last_validated_at,null);
    console.log('PASS expired dashboard token blocks feed and HTTP create, clears validation, zero upstream');
  } finally {console.warn=nativeWarn;globalThis.fetch=nativeFetch;login.stopLogins();await new Promise(r=>server.close(r));}
} finally {globalThis.fetch=fetchLocal;db?.close();rmSync(temp,{recursive:true,force:true});}
