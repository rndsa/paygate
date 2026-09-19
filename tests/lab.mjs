// Synthetic LAB integration fixtures. No upstream network, merchant account or real money.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'paygate-lab-'));
let db;
try {
  cpSync(path.join(root, 'src'), path.join(temp, 'src'), { recursive: true });
  symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
  Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(temp, 'test.db'), PAYGATE_DATA_DIR: temp,
    ENCRYPTION_KEY: 'aa'.repeat(32), COOKIE_SECRET: '22'.repeat(32), LAB_UNOFFICIAL: '1', LAB_USER_ID: '1', ENABLE_MOCK_PAY: '0',
    GOPAY_ACCESS_TOKEN: '', GOPAY_MERCHANT_ID: '', GOPAY_QRIS_STATIC: '', SHOPEEPAY_TOKEN: '', SHOPEEPAY_MERCHANT_ID: '', SHOPEEPAY_STORE_ID: '', SHOPEEPAY_QRIS_STATIC: '' });
  const load = file => import(pathToFileURL(path.join(temp, 'src', file)));
  ({ db } = await load('db/index.js'));
  const { config } = await load('config.js');
  const { crc16ccitt } = await load('lib/qris.js');
  const source = '00020101021153033605802ID5911PAYGATE LAB6007JAKARTA6304';
  const qr = source + crc16ccitt(source);
  for (const uid of [1, 2]) db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(uid, `lab${uid}`, 'test-only', Date.now(), Date.now());
  // Import existing module when new module is absent so RED asserts behavior, not a typo.
  const lab = await load('services/lab.js').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
  assert.equal(typeof lab.syncLabAccounts, 'function', 'LAB lifecycle must exist');
  config.gopayLab = { accessToken: 'synthetic-token-no-live-account', merchantId: 'LAB1', staticQris: qr };
  lab.syncLabAccounts();
  let account = db.prepare("SELECT * FROM payment_accounts WHERE provider='gopay'").get();
  assert.equal(account.status, 'configured', 'env presence is not a verified connection');
  assert.ok(!account.credential.includes(config.gopayLab.accessToken));
  assert.equal(lab.getLabAccount('gopay', 2), null, 'owner boundary');
  lab.pauseLabAccount('gopay', 1);
  lab.syncLabAccounts();
  assert.equal(lab.getLabAccount('gopay', 1).status, 'paused', 'restart never auto-resumes');
  console.log('PASS encrypted env sync, owner scope, configured-not-active, durable pause');
  assert.equal(typeof lab.pollLabAccount, 'function', 'one shared rate-limited polling path');
  let calls = 0;
  const empty = { fetch: async () => { calls++; return Response.json({ from: 0, size: 100, total: 0, transactions: [] }); } };
  assert.equal((await lab.pollLabAccount('gopay', 1, { test: true, ...empty })).ok, true);
  assert.equal(lab.getLabAccount('gopay', 1).status, 'active');
  assert.equal((await lab.pollLabAccount('gopay', 1, { test: true, ...empty })).code, 'COOLDOWN');
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM console_events WHERE event='PROVIDER_POLL'").get().n,1,'successful poll logged once; cooldown skip not logged');
  db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
  const denied = { fetch: async () => { calls++; return Response.json({ secret: 'DO-NOT-LOG' }, { status: 401 }); } };
  assert.equal((await lab.pollLabAccount('gopay', 1, { test: true, ...denied })).ok, false);
  assert.equal(lab.getLabAccount('gopay', 1).status, 'blocked');
  db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
  await lab.pollLabAccount('gopay', 1, empty);
  assert.equal(calls, 2, 'auth error stops background retries');
  lab.syncLabAccounts();
  assert.equal(lab.getLabAccount('gopay', 1).status, 'blocked');
  assert.ok(!lab.getLabAccount('gopay', 1).last_error.includes('DO-NOT-LOG'));
  console.log('PASS shared cooldown, auth stop, no secret errors, no restart reset');
  db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
  let pendingSignal, releaseFetch, startFetch;
  const started = new Promise(resolve => { startFetch = resolve; });
  const pending = lab.pollLabAccount('gopay', 1, { test: true, fetch: (_url, { signal }) => new Promise((resolve, reject) => {
    pendingSignal = signal; releaseFetch = resolve;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    startFetch();
  }) });
  await started;
  const cooldown = lab.getLabAccount('gopay', 1).next_poll_at;
  lab.pauseLabAccount('gopay', 1);
  const aborted = pendingSignal.aborted;
  releaseFetch(Response.json({ from: 0, size: 100, total: 0, transactions: [] }));
  const cancelled = await pending;
  assert.equal(aborted, true, 'Pause aborts in-flight provider fetch');
  assert.equal(cancelled.code, 'CANCELLED');
  lab.syncLabAccounts();
  assert.equal(lab.getLabAccount('gopay', 1).status, 'paused');
  assert.equal(lab.getLabAccount('gopay', 1).next_poll_at, cooldown, 'Pause/restart retains cooldown');
  console.log('PASS Pause aborts in-flight fetch, cancellation preserves durable pause/cooldown');
  for (const pauseMode of ['local', 'revision']) {
    db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
    let pageCalls = 0, releasePage, startPage;
    const pageStarted = new Promise(resolve => { startPage = resolve; });
    // Deliberately ignore abort: late page completion must not start another fetch.
    const paginating = lab.pollLabAccount('gopay', 1, { test: true, fetch: async () => {
      pageCalls++;
      if (pageCalls === 1) {
        startPage();
        return new Promise(resolve => { releasePage = resolve; });
      }
      return Response.json({ from: 1, size: 100, total: 2, transactions: [{}] });
    } });
    await pageStarted;
    const lease = lab.getLabAccount('gopay', 1).next_poll_at;
    if (pauseMode === 'local') lab.pauseLabAccount('gopay', 1);
    else db.prepare("UPDATE payment_accounts SET status='paused',updated_at=updated_at+1 WHERE id=?").run(account.id);
    releasePage(Response.json({ from: 0, size: 100, total: 2, transactions: [{}] }));
    assert.equal((await paginating).code, 'CANCELLED');
    assert.equal(pageCalls, 1, `${pauseMode} Pause prevents next pagination fetch even when abort ignored`);
    lab.syncLabAccounts();
    assert.equal(lab.getLabAccount('gopay', 1).status, 'paused');
    assert.equal(lab.getLabAccount('gopay', 1).next_poll_at, lease);
  }
  console.log('PASS Pause/revision blocks next page despite ignored abort, durable cooldown retained');
  db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
  let rejectFetch;
  const staleFailure = lab.pollLabAccount('gopay', 1, { test: true, fetch: () => new Promise((_, reject) => { rejectFetch = reject; }) });
  db.prepare("UPDATE payment_accounts SET status='paused',updated_at=updated_at+1 WHERE id=?").run(account.id);
  const staleCooldown = lab.getLabAccount('gopay', 1).next_poll_at;
  rejectFetch(new Error('synthetic network failure after Pause'));
  assert.equal((await staleFailure).code, 'CANCELLED', 'stale failed fetch reports cancellation, not provider error');
  assert.equal(lab.getLabAccount('gopay', 1).status, 'paused');
  assert.equal(lab.getLabAccount('gopay', 1).next_poll_at, staleCooldown);
  db.prepare("UPDATE payment_accounts SET status='active',next_poll_at=0").run();
  account = lab.getLabAccount('gopay', 1);
  const t = Math.floor(Date.now() / 1000) * 1000 - 2000;
  const insert = (id, amount, start=t-1000, end=t+60000, status='pending') => db.prepare('INSERT INTO orders(id,user_id,provider,account_id,amount,expires_at,created_at,updated_at,status,payment_origin) VALUES(?,?,?,?,?,?,?,?,?,\'live\')').run(id,1,'gopay',account.id,amount,end,start,start,status);
  insert('ORD-LAB-000000000001', 43210);
  assert.equal(lab.handleLabTransaction(account, {txid:'tx1',amount:43210,time:t}), true);
  assert.equal(lab.handleLabTransaction(account, {txid:'tx1',amount:43210,time:t}), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM console_events WHERE event='PAYMENT_MATCH'").get().n,1,'committed match logged once; duplicate transaction creates no history');
  insert('ORD-LAB-000000000002',54321); insert('ORD-LAB-000000000003',54321);
  assert.equal(lab.handleLabTransaction(account, {txid:'ambiguous',amount:54321,time:t}), false);
  assert.equal(db.prepare("SELECT consumed_by FROM seen_transactions WHERE txid='ambiguous'").get().consumed_by,null);
  insert('ORD-LAB-000000000004', 999,t-1000,t+1000,'expired');
  assert.equal(lab.handleLabTransaction(account,{txid:'late-poll',amount:999,time:t}),true,'payment before expiry is reconciled despite UI expiry');
  insert('ORD-LAB-000000000005',123);
  assert.equal(lab.handleLabTransaction({...account,user_id:2},{txid:'wrong-user',amount:123,time:t}),false);
  assert.equal(lab.handleLabTransaction(account,{txid:'old',amount:123,time:t-5000}),false);
  assert.equal(lab.handleLabTransaction(account,{txid:'future',amount:123,time:Date.now()+60000}),false);
  db.exec("CREATE TRIGGER fail_lab BEFORE UPDATE OF status ON orders WHEN NEW.id='ORD-LAB-000000000005' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END");
  assert.throws(()=>lab.handleLabTransaction(account,{txid:'rollback',amount:123,time:t}),/fixture write failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM seen_transactions WHERE txid='rollback'").get().n,0);
  db.exec('DROP TRIGGER fail_lab');
  lab.pauseLabAccount('gopay',1);
  assert.equal(lab.handleLabTransaction(account,{txid:'paused',amount:123,time:t}),false);
  // Second-resolution feed cannot distinguish pre-order transfer from same-second payment.
  db.prepare("UPDATE payment_accounts SET status='active'").run();
  account = lab.getLabAccount('gopay',1);
  insert('ORD-LAB-000000000006', 777, t+100, t+60000);
  assert.equal(lab.handleLabTransaction(account,{txid:'boundary-review',amount:777,time:t}),false);
  assert.equal(lab.handleLabTransaction(account,{txid:'boundary-review',amount:777,time:t}),false);
  const review = db.prepare("SELECT account_id,consumed_by,amount,tx_time FROM seen_transactions WHERE txid='boundary-review'").get();
  assert.equal(review.account_id,account.id); assert.equal(review.consumed_by,null);
  assert.equal(review.amount,777); assert.equal(review.tx_time,t);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id='ORD-LAB-000000000006'").get().status,'pending');
  lab.pauseLabAccount('gopay',1);
  console.log('PASS exact amount, dedup, ambiguity quarantine, late feed, tenant/time boundary, atomic rollback');
  console.log('PASS same-second ambiguity retained in owned feed for manual review; no unsafe tolerance');
  // Same real Express routers on loopback with normal session+CSRF middleware; upstream stays synthetic.
  const express = (await import(path.join(root,'node_modules/express/index.js'))).default;
  const security = await load('middleware/security.js');
  const orders = (await load('routes/orders.js')).default;
  const accounts = (await load('routes/accounts.js')).default;
  const app = express(); app.use(express.json()); app.use(security.parseCookies); app.use(security.sessionMiddleware);
  app.use('/api/orders',security.optionalApiKeyAuth); app.use(security.csrf); app.use(security.requireAuth);
  app.use('/api/accounts',accounts); app.use('/api/orders',orders);
  app.use((req,res)=>res.status(404).json({error:'Endpoint tidak ditemukan.'}));
  app.use((err,req,res,next)=>res.status(500).json({error:'fixture server error'}));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const nativeFetch = globalThis.fetch;
  for (const uid of [1,2]) db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)').run(`lab-session-${uid}`,uid,Date.now(),Date.now()+600000);
  const { TERMS_VERSION } = await load('routes/terms.js');
  const signedTerms = version => {
    const payload = `${version}.${Date.now()+86400000}`;
    return `paygate_terms=${payload}.${createHmac('sha256',config.cookieSecret).update(`paygate:terms:${payload}`).digest('hex')}`;
  };
  const termsCookie = signedTerms(TERMS_VERSION);
  const invalidTerms = ['',signedTerms('2026-09-08'),termsCookie.slice(0,-1)+(termsCookie.endsWith('0')?'1':'0')];
  const api = async (route,body,uid=1,csrf=true,terms=termsCookie) => {
    const r=await nativeFetch(`http://127.0.0.1:${server.address().port}/api/`+route,{method:body?'POST':'GET',headers:{Cookie:`paygate_sid=lab-session-${uid}; paygate_csrf=0123456789abcdef0123456789abcdef; ${terms}`, 'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':'0123456789abcdef0123456789abcdef'}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual'});
    return {status:r.status,data:await r.json()};
  };
  try {
    globalThis.fetch = async (url,init) => { assert.ok(String(url).startsWith('https://api.gojekapi.com/')); calls++; return Response.json({from:0,size:100,total:0,transactions:[]}); };
    db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
    const beforeCalls=calls, beforeAccount=lab.getLabAccount('gopay',1);
    for (const route of ['accounts/test','accounts/resume']) {
      for (const terms of invalidTerms) {
        const rejected=await api(route,{provider:'gopay'},1,true,terms);
        assert.equal(calls,beforeCalls,`${route}: rejected consent must make zero provider calls`);
        assert.deepEqual(rejected,{status:403,data:{error:'Baca dan setujui Syarat Penggunaan terlebih dahulu.',code:'TERMS_REQUIRED'}});
        assert.deepEqual(lab.getLabAccount('gopay',1),beforeAccount,'rejected consent cannot activate account or reserve polling');
      }
    }
    for (const terms of invalidTerms) {
      assert.equal((await api('accounts',undefined,1,true,terms)).status,200);
      const before=calls;
      assert.equal((await api('accounts/resume',{provider:'gopay'})).status,200);
      assert.equal(calls,before+1,'current consent permits provider validation');
      const active=lab.getLabAccount('gopay',1);
      assert.equal(active.status,'active');
      assert.equal((await api('accounts/pause',{provider:'gopay'},1,true,terms)).status,200);
      assert.equal(lab.getLabAccount('gopay',1).status,'paused');
      assert.equal(lab.getLabAccount('gopay',1).next_poll_at,active.next_poll_at);
      assert.equal(calls,before+1,'pause needs no current consent and makes zero provider calls');
      db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
    }
    console.log('PASS HTTP feed consent: missing/old/corrupt rejected before provider or state changes; current accepted; active pause/read remain accessible');
    const meta=await api('accounts'); assert.equal(meta.data.lab.owner,true); assert.equal(meta.data.lab.providers[0].configured,true);
    assert.ok(!JSON.stringify(meta.data).includes(config.gopayLab.accessToken));
    assert.equal((await api('accounts',undefined,2)).data.lab.owner,false);
    assert.equal((await api('accounts/test',{provider:'gopay'},2)).status,503);
    assert.equal((await api('accounts/test',{provider:'gopay'},1,false)).status,403);
    assert.equal((await api('orders/create',{provider:'gopay',amount:25001})).status,503,'paused account cannot create QR');
    db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
    assert.equal((await api('accounts/test',{provider:'gopay'})).status,200);
    assert.equal((await api('accounts/test',{provider:'gopay'})).status,429);
    assert.equal((await api('orders/create',{provider:'gopay',amount:25001},2)).status,503);
    assert.equal((await api('orders/create',{provider:'gopay',amount:100001})).status,422);
    const race=await Promise.all([api('orders/create',{provider:'gopay',amount:25001}),api('orders/create',{provider:'gopay',amount:25001})]);
    assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
    const created=race.find(r=>r.status===201).data;
    assert.equal(Object.hasOwn(created,"mock"),false); assert.equal(created.lab_unofficial,true);
    assert.equal(created.expires_at % 1000, 0, 'LAB expiry aligns to coarse provider seconds; no post-expiry fraction accepted');
    assert.equal((await api(`orders/${created.order_id}/simulate-payment`,{})).status,404);
    const status=await api(`orders/${created.order_id}/status`); assert.equal(status.data.lab_unofficial,true);
    // Full real parser -> shared poller -> SQLite -> HTTP status with synthetic upstream only.
    const paymentTime = new Date().toISOString();
    globalThis.fetch = async () => Response.json({from:0,size:100,total:1,transactions:[{id:'feed-end-to-end',merchant_id:'LAB1',transaction_status:'SETTLEMENT',payment_type:'QRIS',gross_amount:2500100,transaction_time:paymentTime}]});
    db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
    assert.equal((await api('accounts/test',{provider:'gopay'})).status,200);
    assert.equal((await api(`orders/${created.order_id}/status`)).data.status,'paid');
    db.prepare('UPDATE payment_accounts SET next_poll_at=0').run();
    assert.equal((await api('accounts/test',{provider:'gopay'})).status,200);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM seen_transactions WHERE txid='feed-end-to-end'").get().n,1);
    assert.equal((await api('orders/create',{provider:'gopay',amount:25001})).status,409,'amount never reused after paid');
    assert.equal((await api('accounts/pause',{provider:'gopay'})).status,200);
    assert.equal((await api('orders/create',{provider:'gopay',amount:25002})).status,503);
    console.log('PASS LAB HTTP controls, CSRF, tenant, pause, limit, concurrent duplicate order, no simulation');
  } finally { globalThis.fetch=nativeFetch; await new Promise(resolve=>server.close(resolve)); }
} finally {
  db?.close(); rmSync(temp, { recursive: true, force: true });
}
