import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'paygate-check-'));
const savedEnv = { ...process.env };
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('Upstream fetch forbidden in backend tests');
  return nativeFetch(url, ...args);
};
const baseEnv = { ...process.env, PAYGATE_DATA_DIR: path.join(temp, 'data'), RATE_LIMIT_MAX: '1000', NODE_ENV: 'test', LAB_UNOFFICIAL: '0', LAB_USER_ID: '', GOPAY_ACCESS_TOKEN: '', GOPAY_MERCHANT_ID: '', GOPAY_QRIS_STATIC: '', SHOPEEPAY_TOKEN: '', SHOPEEPAY_MERCHANT_ID: '', SHOPEEPAY_STORE_ID: '', SHOPEEPAY_QRIS_STATIC: '', DB_PATH: path.join(temp, 'test.db'), ENCRYPTION_KEY: '11'.repeat(32), COOKIE_SECRET: '22'.repeat(32) };
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS', name); }
try {
  for (const dir of ['src', 'views', 'public', 'docs', 'examples']) cpSync(path.join(root, dir), path.join(temp, dir), { recursive: true });
  if (existsSync(path.join(root, 'LICENSE'))) cpSync(path.join(root, 'LICENSE'), path.join(temp, 'LICENSE'));
  symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
  function readConfig(file, override = {}) {
    writeFileSync(path.join(temp, '.env'), file);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {config} from ${JSON.stringify(pathToFileURL(path.join(temp, 'src/config.js')).href)}; console.log(JSON.stringify(config));`], { env: { ...baseEnv, ...override }, encoding: 'utf8' });
    return { ...result, value: result.status === 0 ? JSON.parse(result.stdout.trim()) : null };
  }
  check('obsolete mock environment cannot activate removed config in any environment', () => {
    for (const NODE_ENV of ['test', 'development', 'production']) {
      const r = readConfig('ENABLE_MOCK_PAY=1\nDEFAULT_PROVIDER=mock\nMOCK_AUTOPAY_PROBABILITY=bad\n', { NODE_ENV, ENABLE_MOCK_PAY: '1', MOCK_AUTOPAY_PROBABILITY: '1' });
      assert.equal(r.status, 0, r.stderr);
      for (const key of ['mockAutopay', 'mockEnabled', 'defaultProvider', 'pollIntervalMs', 'paymentTolerance']) assert.equal(Object.hasOwn(r.value, key), false, key);
    }
  });
  check('process environment overrides .env', () => {
    assert.equal(readConfig('NODE_ENV=production\nPORT=3000\n', { PORT: '3333', NODE_ENV: 'production' }).value.port, 3333);
  });
  check('setup emits no mock default or testing-mode promise', () => {
    const setup = readFileSync(path.join(temp, 'src/setup.js'), 'utf8');
    assert.doesNotMatch(setup, /mock|DEFAULT_PROVIDER/i);
    assert.match(setup, /belum terhubung/);
  });
  check('unofficial providers are opt-in and use a slow polling floor', () => {
    assert.equal(readConfig('').value.labUnofficialEnabled, false);
    assert.notEqual(readConfig('', { LAB_UNOFFICIAL: '1' }).status, 0);
    const enabled = readConfig('', { LAB_UNOFFICIAL: '1', LAB_USER_ID: '1', LAB_POLL_INTERVAL_MS: '5000' }).value;
    assert.equal(enabled.labUnofficialEnabled, true);
    assert.equal(enabled.labPollIntervalMs, 30000);
  });
  writeFileSync(path.join(temp, '.env'), '');
  Object.assign(process.env, baseEnv, { ENABLE_MOCK_PAY: '1', MOCK_AUTOPAY_PROBABILITY: '1' });
  const { db } = await import(pathToFileURL(path.join(temp, 'src/db/index.js')).href);
  const { config } = await import(pathToFileURL(path.join(temp, 'src/config.js')).href);
  const poller = await import(pathToFileURL(path.join(temp, 'src/services/poller.js')).href);
  check('LAB OFF starts no timer and exports no simulation handlers', () => {
    const interval = globalThis.setInterval;
    let timers = 0;
    globalThis.setInterval = () => { timers++; return 0; };
    try {
      poller.startPolling();
      poller.stopPolling();
      assert.equal(timers, 0);
      assert.equal(poller.handleIncomingTransaction, undefined);
      for (const name of ['runPollCycle', 'mockIncomingTransactions', 'handleIncomingTransaction']) assert.equal(poller._test?.[name], undefined);
    } finally { globalThis.setInterval = interval; }
  });
  const qris = await import(pathToFileURL(path.join(temp, 'src/lib/qris.js')).href);
  const staticWithoutCrc = '00020101021153033605802ID5911PAYGATE LAB6007JAKARTA6304';
  const testStaticQris = staticWithoutCrc + qris.crc16ccitt(staticWithoutCrc);
  check('dynamic QRIS injects an exact IDR amount and keeps a valid CRC', () => {
    const staticPayload = testStaticQris;
    assert.equal(qris.isValidQris(staticPayload), true);
    const dynamic = qris.staticToDynamicQris(staticPayload, 25001);
    assert.equal(qris.getQrisField(dynamic, '01'), '12');
    assert.equal(qris.getQrisField(dynamic, '54'), '25001');
    assert.equal(qris.isValidQris(dynamic), true);
  });
  const { createHash } = await import('node:crypto');
  const { encrypt } = await import(pathToFileURL(path.join(temp, 'src/lib/crypto.js')).href);
  const providerModule = await import(pathToFileURL(path.join(temp, 'src/services/provider.js')).href);
  await (async () => {
    const key = Buffer.from(baseEnv.ENCRYPTION_KEY, 'hex');
    const nowIso = new Date().toISOString();
    const gopayRaw = encrypt(JSON.stringify({ access_token: 'test-access-token-value', merchant_id: 'MERCHANT-1', qris_static: 'unused' }), key);
    let requestedUrl = '';
    const gopay = providerModule.getProviderFor('gopay', { fetch: async url => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ from: 0, size: 100, total: 1, transactions: [{ id: 'GP-1', merchant_id: 'MERCHANT-1', transaction_status: 'SETTLEMENT', payment_type: 'QRIS', gross_amount: 2500100, transaction_time: nowIso }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }});
    const gpRows = await gopay.getTransactions({ credential: gopayRaw }, key, Date.now() - 60_000);
    assert.equal(gpRows.length, 1);
    assert.deepEqual({ txid: gpRows[0].txid, amount: gpRows[0].amount }, { txid: 'GP-1', amount: 25001 });
    assert.match(requestedUrl, /merchant-analytics\/v2\/merchants\/transactions/);

    const shopeeRaw = encrypt(JSON.stringify({ token: 'B:test-merchant-token-value', merchant_id: '12', store_id: '34', qris_static: 'unused' }), key);
    const shopee = providerModule.getProviderFor('shopeepay', { fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.data.metadata.token, 'B:test-merchant-token-value');
      return new Response(JSON.stringify({ code: 0, data: { list: [{ transactionId: 'SP-1', merchantId: 12, storeId: 34, amount: '25.001', status: 3, service: 1, createTime: Math.floor(Date.now() / 1000) }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }});
    const spRows = await shopee.getTransactions({ credential: shopeeRaw }, key, Date.now() - 60_000);
    assert.equal(spRows.length, 1);
    assert.deepEqual({ txid: spRows[0].txid, amount: spRows[0].amount }, { txid: 'SP-1', amount: 25001 });
    checks += 2;
    console.log('PASS GoPay lab adapter normalizes settled analytics transactions');
    console.log('PASS ShopeePay lab adapter normalizes completed scoped transactions');
  })();
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const net = await import('node:net');
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const now = Date.now();
  for (const uid of [1, 2]) {
    db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES (?,?,?,?,?)').run(uid, `tester${uid}`, 'not-a-live-password', now, now);
    db.prepare('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(`test-session-${uid}`, uid, now, now + 600000);
    db.prepare('INSERT INTO api_keys(user_id,name,key_hash,prefix,created_at) VALUES (?,?,?,?,?)').run(uid, 'test', createHash('sha256').update(`test-api-${uid}`).digest('hex'), 'test', now);
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', `globalThis.fetch = async () => { throw new Error('Upstream fetch forbidden in backend test server'); }; await import(${JSON.stringify(pathToFileURL(path.join(temp, 'src/server.js')).href)});`], { env: { ...baseEnv, PORT: String(port), HOST: '127.0.0.1', ENABLE_MOCK_PAY: '1', MOCK_AUTOPAY_PROBABILITY: '1', LAB_UNOFFICIAL: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', b => { logs += b; });
  child.stderr.on('data', b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  let termsCookie = '';
  async function request(url, { method = 'GET', body, uid = 1, key, csrf = true, session = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (session) headers.Cookie = `paygate_sid=test-session-${uid}; paygate_csrf=0123456789abcdef0123456789abcdef; ${termsCookie}`;
    if (csrf) headers['X-CSRF-Token'] = '0123456789abcdef0123456789abcdef';
    if (key !== undefined) headers['X-Api-Key'] = key;
    const response = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  async function apiCheck(name, fn) { await fn(); checks++; console.log('PASS', name); }
  try {
    const deadline = Date.now() + 10000;
    while (!logs.includes('PayGate running')) {
      assert.ok(child.exitCode === null && Date.now() < deadline, logs);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await apiCheck('MIT HTML and exact raw licence are public without exposing project files', async () => {
      const r=await request('/license',{session:false});
      assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);
      assert.match(r.data,/<h1>Lisensi MIT<\/h1>/);
      for (const label of ['Izin penggunaan','Syarat distribusi','Batasan tanggung jawab']) assert.ok(r.data.includes(label));
      assert.match(r.data,/<details class="license-raw">[\s\S]*<pre[^>]*>/);
      assert.match(r.data,/href="\/license.txt"/);
      const raw=await request('/license.txt',{session:false});
      assert.equal(raw.status,200);assert.match(raw.headers.get('content-type'),/text\/plain/);
      assert.equal(raw.data,readFileSync(path.join(root,'LICENSE'),'utf8'));
      const decoded=r.data.match(/<pre id="licenseText">([\s\S]*?)<\/pre>/)?.[1]
        .replace(/&#34;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
      assert.equal(decoded,raw.data,'HTML details contains complete unmodified MIT licence');
      assert.match(raw.data,/MIT License/);assert.match(raw.data,/Copyright \(c\) 2026 ren/);assert.match(raw.data,/WITHOUT WARRANTY OF ANY KIND/);
      for (const route of ['/license/.env','/license.txt/.env']) assert.equal((await request(route,{session:false})).status,302);
      const faq=await request('/terms/details',{session:false});
      assert.equal(faq.status,200);assert.equal((faq.data.match(/class="terms-faq-item"/g)||[]).length,8);
      assert.equal((await request('/tos',{session:false})).status,302,'Dashboard ToS remains authenticated');
    });
    await apiCheck('first visit requires ToS; acceptance persists without granting authentication', async () => {
      const initial = await request('/login');
      assert.equal(initial.status, 303);
      assert.match(initial.headers.get('location'), /^\/terms\?/);
      const before = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
      const denied = await request('/login', {method:'POST',body:{username:'tester1',password:'unused-password'}});
      assert.equal(denied.status,403);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,before);
      const terms = await request('/terms');
      assert.equal(terms.status,200);
      const version = terms.data.match(/name="version" value="([^"]+)"/)[1];
      const accepted = await request('/terms/accept',{method:'POST',body:{version,accepted:'yes',next:'/dashboard'}});
      assert.equal(accepted.status,303);
      termsCookie=accepted.headers.getSetCookie().find(c=>c.startsWith('paygate_terms=')).split(';')[0];
      assert.equal((await request('/dashboard')).status,200);
      assert.equal((await request('/tos')).status,200);
      assert.equal((await request('/api/orders',{session:false})).status,401);
      assert.equal((await request('/healthz',{session:false})).status,200);
    });
    await apiCheck('Shopee password router mounted and terms-gated; importer metadata is owner-scoped', async () => {
      const meta=(await request('/api/accounts')).data;
      assert.equal(meta.login.shopeepay.method,'browser_password');
      assert.equal(meta.connection.shopeepay.method,'session_import');
      assert.equal(meta.connection.shopeepay.available,false);
      const saved=termsCookie;termsCookie='';
      for(const step of ['start','verify','finish']) {
        const response=await request('/api/accounts/shopee/login/'+step,{method:'POST',body:{}});
        assert.equal(response.status,403); assert.equal(response.data.code,'TERMS_REQUIRED');
      }
      termsCookie=saved;
      assert.notEqual((await request('/api/accounts/shopee/login/start',{method:'POST',body:{}})).status,404);
    });
    await apiCheck('owner-scoped Shopee importer stays terms-gated, CSRF-safe and mutation-free when LAB is off', async () => {
      const before=db.prepare('SELECT COUNT(*) n FROM payment_accounts').get().n;
      const saved=termsCookie;termsCookie='';
      const noTerms=await request('/api/accounts/shopee/connect',{method:'POST',body:{}});
      assert.equal(noTerms.status,403); assert.equal(noTerms.data.code,'TERMS_REQUIRED');
      termsCookie=saved;
      assert.equal((await request('/api/accounts/shopee/connect',{method:'POST',body:{},csrf:false})).status,403);
      const forbidden=await request('/api/accounts/shopee/connect',{method:'POST',body:{}});
      assert.equal(forbidden.status,403); assert.equal(forbidden.data.code,'FORBIDDEN');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_accounts').get().n,before);
    });
    await apiCheck('API, LAB and website files download only through authenticated allowlisted routes', async () => {
      for (const name of ['API.md','LAB.md','WEBSITE.md','SHOPEE_CONNECT.md','website.mjs']) {
        const doc = await request('/docs/' + name);
        assert.equal(doc.status, 200);
        assert.match(doc.headers.get('content-disposition'), /attachment/);
        assert.ok(typeof doc.data === 'string' && doc.data.length > 100);
        assert.notEqual((await request('/docs/' + name, { session: false })).status, 200);
      }
      assert.notEqual((await request('/docs/.env')).status, 200);
    });
    await apiCheck('explicit real provider required; rejected create never inserts or generates fallback', async () => {
      const before = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
      for (const provider of [undefined, null, '', 'mock', 'unknown', 'GOPAY', {}, ['gopay'], 'gopay\n']) {
        const r = await request('/api/orders/create', { method: 'POST', body: { amount: 25000, provider } });
        assert.equal(r.status, 422, JSON.stringify({ provider, ...r.data }));
        assert.equal(r.data.qris_payload, undefined);
      }
      for (const amount of [null, true, {}, [], 0, -1, 1.5, 'bad', 1000000001]) {
        assert.equal((await request('/api/orders/create', { method: 'POST', body: { amount, provider: 'gopay' } })).status, 422);
      }
      assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, before);
    });
    await apiCheck('arbitrary API header cannot bypass CSRF on session routes', async () => {
      const r = await request('/api/api-keys', { method: 'POST', body: { name: 'csrf-attack' }, csrf: false, key: 'invalid' });
      assert.equal(r.status, 403, JSON.stringify(r.data));
    });
    await apiCheck('validated key works without cookies; invalid key never falls back to session', async () => {
      const r = await request('/api/orders/create', { method: 'POST', body: { amount: 15000, provider: 'gopay' }, csrf: false, session: false, key: 'test-api-1' });
      assert.equal(r.status, 503, JSON.stringify(r.data));
      assert.equal((await request('/api/orders', { key: 'invalid' })).status, 401);
      assert.equal((await request('/api/orders/create', { method: 'POST', body: { amount: 1 }, key: 'invalid', csrf: false })).status, 401);
      assert.equal((await request('/api/orders/create', { method: 'POST', body: { amount: 1 }, csrf: false })).status, 403);
      assert.equal((await request('/api/orders', { session: false })).status, 401);
    });
    await apiCheck('disabled live providers fail closed without creating orders', async () => {
      for (const provider of ['shopeepay', 'gopay']) {
        assert.equal((await request('/api/orders/create', { method: 'POST', body: { amount: 27000, provider } })).status, 503);
        assert.equal((await request('/api/accounts/test', { method: 'POST', body: { provider } })).status, 503);
      }
      assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
    });
    const n = Date.now();
    db.prepare("INSERT INTO payment_accounts(user_id,provider,label,credential,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(1, 'gopay', 'synthetic fixture', 'not-a-real-secret', n, n);
    const seed = (id, provider, origin, status = 'pending', expiry = n + 60000, amount = 1000) => {
      db.prepare('INSERT INTO orders(id,user_id,provider,payment_origin,amount,status,qris_payload,qris_image,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, 1, provider, origin, amount, status, 'PAYGATE-DEMO:historical', 'data:image/png;base64,SYNTHETIC', expiry, n - 10000, n - 10000);
    };
    seed('ORD-TEST-000000000001', 'mock', 'legacy_unverified');
    seed('ORD-TEST-000000000002', 'gopay', 'legacy_unverified', 'paid');
    seed('ORD-TEST-000000000003', 'gopay', 'legacy_unverified', 'pending', n - 1);
    seed('ORD-TEST-000000000004', 'gopay', 'live', 'pending', n + 60000);
    seed('ORD-TEST-000000000005', 'shopeepay', 'live', 'paid', n + 60000, 2345);
    seed('ORD-TEST-000000000006', 'shopeepay', 'live', 'pending', n - 1);
    seed('ORD-TEST-000000000007', 'unknown', 'legacy_unverified');
    db.prepare("UPDATE orders SET qris_payload=? WHERE id='ORD-TEST-000000000002'").run(testStaticQris);
    db.prepare("UPDATE orders SET claimed_txid='HISTORICAL-CLAIM' WHERE id='ORD-TEST-000000000002'").run();
    await apiCheck('removed simulation endpoint always 404 with zero order or settlement writes', async () => {
      const before = db.prepare('SELECT * FROM orders ORDER BY id').all();
      for (const id of ['ORD-TEST-000000000001', 'ORD-TEST-000000000004', 'does-not-exist']) {
        const url = `/api/orders/${id}/simulate-payment`;
        assert.equal((await request(url, { method: 'POST' })).status, 404);
        assert.equal((await request(url, { method: 'POST', uid: 2 })).status, 404);
        assert.equal((await request(url, { method: 'POST', session: false, csrf: false, key: 'test-api-1' })).status, 404);
        assert.equal((await request(url, { method: 'POST', csrf: false })).status, 403);
        assert.equal((await request(url, { method: 'POST', session: false })).status, 403);
        assert.equal((await request(url, { method: 'POST', key: 'invalid' })).status, 401);
      }
      assert.deepEqual(db.prepare('SELECT * FROM orders ORDER BY id').all(), before);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM seen_transactions').get().n, 0);
    });
    await apiCheck('legacy reads hide QR, retain provenance and stored claims, never expire legacy rows', async () => {
      const before = db.prepare("SELECT * FROM orders WHERE payment_origin='legacy_unverified' ORDER BY id").all();
      for (const row of before) {
        const r = await request(`/api/orders/${row.id}/status`);
        assert.equal(r.status, 200);
        assert.equal(r.data.payment_origin, 'legacy_unverified');
        assert.equal(r.data.lab_unofficial, false);
        assert.equal(r.data.qris_payload, null);
        assert.equal(r.data.qris_image, null);
        assert.equal(r.data.status, row.status);
        assert.equal(r.data.claimed_txid, row.claimed_txid);
        assert.equal((await request(`/api/orders/${row.id}/status`, { uid: 2 })).status, 404);
      }
      assert.deepEqual(db.prepare("SELECT * FROM orders WHERE payment_origin='legacy_unverified' ORDER BY id").all(), before);
      const rows = (await request('/api/orders')).data.orders;
      assert.ok(rows.every(row => ['live', 'legacy_unverified'].includes(row.payment_origin)));
      assert.ok(rows.every(row => row.lab_unofficial === (row.payment_origin === 'live')));
      assert.deepEqual((await request('/api/orders', { uid: 2 })).data.orders, []);
      assert.equal((await request('/api/orders/invalid/status')).status, 400);
    });
    await apiCheck('dashboard includes live only and excludes elapsed pending; real-only polling skips when disabled', async () => {
      const r = await request('/api/dashboard/summary');
      assert.equal(r.status, 200);
      assert.equal(r.data.stats.orders_total, 3);
      assert.equal(r.data.stats.orders_pending, 1);
      assert.equal(r.data.stats.orders_paid, 1);
      assert.equal(r.data.stats.revenue_paid, 2345);
      assert.equal(r.data.recentOrders.length, 3);
      assert.ok(r.data.recentOrders.every(o => o.payment_origin === 'live' && ['gopay', 'shopeepay'].includes(o.provider)));
      const before = db.prepare('SELECT * FROM orders ORDER BY id').all();
      const polled = await request('/api/dashboard/poll-now', { method: 'POST' });
      assert.equal(polled.status, 200);
      assert.equal(polled.data.lab.skipped, true);
      assert.equal(polled.data.lab.ok, false);
      assert.deepEqual(db.prepare('SELECT * FROM orders ORDER BY id').all(), before);
    });
    await apiCheck('live status exposes live provenance and expiry still updates live pending rows', async () => {
      const r = await request('/api/orders/ORD-TEST-000000000004/status');
      assert.equal(r.data.payment_origin, 'live');
      assert.equal(Object.hasOwn(r.data, "mock"), false);
      assert.equal(r.data.lab_unofficial, true);
      const expired = await request('/api/orders/ORD-TEST-000000000006/status');
      assert.equal(expired.data.status, 'expired');
      assert.equal(db.prepare("SELECT status FROM orders WHERE id='ORD-TEST-000000000006'").get().status, 'expired');
    });
    await apiCheck('settled and expired tagihan stop serving their QR payload', async () => {
      // Paid live order: QR must never leave the server again, even though the row still holds it.
      const stored = db.prepare("SELECT qris_payload FROM orders WHERE id='ORD-TEST-000000000005'").get();
      assert.equal(typeof stored.qris_payload, 'string');
      const paid = await request('/api/orders/ORD-TEST-000000000005/status');
      assert.equal(paid.data.status, 'paid');
      assert.equal(paid.data.qris_payload, null);
      assert.equal(paid.data.qris_image, null);
      // Expired live order: same rule once the clock has passed.
      const expired = await request('/api/orders/ORD-TEST-000000000006/status');
      assert.equal(expired.data.status, 'expired');
      assert.equal(expired.data.qris_payload, null);
      assert.equal(expired.data.qris_image, null);
      // The row itself is untouched; only the response is redacted.
      assert.equal(db.prepare("SELECT qris_payload FROM orders WHERE id='ORD-TEST-000000000005'").get().qris_payload, stored.qris_payload);
    });
    await apiCheck('unconsumed transactions belong only to their account owner', async () => {
      const n = Date.now();
      const account = db.prepare("SELECT id FROM payment_accounts WHERE user_id=1 AND provider='gopay'").get().id;
      db.prepare('INSERT INTO seen_transactions(provider,txid,account_id,amount,tx_time,seen_at) VALUES(?,?,?,?,?,?)').run('gopay', 'PRIVATE-UNCONSUMED', account, 123, n, n);
      const own = await request('/api/transactions');
      const other = await request('/api/transactions', { uid: 2 });
      assert.ok(own.data.transactions.some(t => t.txid === 'PRIVATE-UNCONSUMED'));
      assert.ok(!other.data.transactions.some(t => t.txid === 'PRIVATE-UNCONSUMED'));
    });
    await apiCheck('transaction origin comes from joined order; unmatched stays unverified', async () => {
      const account = db.prepare("SELECT id FROM payment_accounts WHERE user_id=1 AND provider='gopay'").get().id;
      const ins=db.prepare('INSERT INTO seen_transactions(provider,txid,account_id,amount,tx_time,seen_at,consumed_by) VALUES(?,?,?,?,?,?,?)');
      ins.run('gopay','ORIGIN-LIVE',account,123,Date.now(),Date.now(),'ORD-TEST-000000000004');
      ins.run('gopay','ORIGIN-LEGACY',account,123,Date.now(),Date.now(),'ORD-TEST-000000000001');
      const rows=(await request('/api/transactions')).data.transactions;
      assert.equal(rows.find(t=>t.txid==='ORIGIN-LIVE').payment_origin,'live');
      assert.equal(rows.find(t=>t.txid==='ORIGIN-LEGACY').payment_origin,'legacy_unverified');
      assert.equal(rows.find(t=>t.txid==='PRIVATE-UNCONSUMED').payment_origin,null);
    });
    await apiCheck('malformed login password returns validation error instead of killing server', async () => {
      const r = await request('/login', { method: 'POST', body: { username: 'tester1', password: { toString: null } }, uid: 99 });
      assert.equal(r.status, 422);
      assert.equal((await request('/healthz')).status, 200);
    });
    await apiCheck('runtime settings report actual config and refuse ineffective writes', async () => {
      const r = await request('/api/settings');
      assert.equal(r.data.read_only, true);
      assert.deepEqual(r.data, { read_only: true, lab_enabled: false, poll_interval_ms: config.labPollIntervalMs, payment_tolerance: 0, order_ttl_minutes: config.orderTtlMinutes });
      assert.equal((await request('/api/settings', { method: 'POST', body: { order_ttl_minutes: 99 } })).status, 503);
    });
    await apiCheck('sensitive responses are not cacheable; malformed cookie gets 400', async () => {
      assert.equal((await request('/api/orders')).headers.get('cache-control'), 'no-store');
      const r = await fetch(base + '/healthz', { headers: { Cookie: 'broken=%ZZ' } });
      assert.equal(r.status, 400);
    });
    await apiCheck('login redirect cannot leave this site', async () => {
      const { hashPassword } = await import(pathToFileURL(path.join(temp, 'src/lib/crypto.js')).href);
      db.prepare('UPDATE users SET password_hash=? WHERE id=1').run(await hashPassword('test-password-only'));
      const r = await request('/login', { method: 'POST', uid: 99, body: { username: 'tester1', password: 'test-password-only', next: '//example.com' } });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/');
      const traversal = await request('/login',{method:'POST',uid:99,body:{username:'tester1',password:'test-password-only',next:'/x/..//evil.test'}});
      assert.equal(traversal.headers.get('location'), '/');
    });
    await apiCheck('live create keeps account/amount gates, provenance, atomic DB rollback and strict settlement', async () => {
      const { default: express } = await import('express');
      const { default: orders } = await import(pathToFileURL(path.join(temp, 'src/routes/orders.js')).href);
      const { handleLabTransaction } = await import(pathToFileURL(path.join(temp, 'src/services/lab.js')).href);
      config.labUnofficialEnabled = true;
      config.labUserId = 1;
      Object.assign(config.gopayLab, { accessToken: 'synthetic-only', merchantId: 'SYNTHETIC', staticQris: testStaticQris });
      const key = Buffer.from(baseEnv.ENCRYPTION_KEY, 'hex');
      const credential = encrypt(JSON.stringify({ access_token: 'synthetic-only', merchant_id: 'SYNTHETIC', qris_static: testStaticQris }), key);
      const app = express();
      app.use(express.json(), (req, _res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
      app.use('/api/orders', orders);
      app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Internal server error.' }));
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const create = async (amount, provider = 'gopay', uid = 1) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/create`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': String(uid) }, body: JSON.stringify({ amount, provider }) });
        return { status: r.status, data: await r.json() };
      };
      try {
        const before = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
        assert.equal((await create(51001)).status, 503);
        db.prepare("UPDATE payment_accounts SET credential=?,status='active',last_validated_at=? WHERE user_id=1 AND provider='gopay'").run(credential, Date.now());
        assert.equal((await create(51001, 'shopeepay')).status, 503);
        assert.equal((await create(51001, 'gopay', 2)).status, 503);
        assert.equal((await create(100001)).status, 422);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, before);
        db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT,'injected DB failure'); END");
        assert.equal((await create(51001)).status, 500);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, before);
        db.exec('DROP TRIGGER fail_insert');
        for (const status of ['configured', 'paused', 'error', 'blocked']) {
          db.prepare("UPDATE payment_accounts SET status=? WHERE user_id=1 AND provider='gopay'").run(status);
          assert.equal((await create(51001)).status, 503);
        }
        db.prepare("UPDATE payment_accounts SET status='active',credential=? WHERE user_id=1 AND provider='gopay'")
          .run(encrypt(JSON.stringify({ qris_static: 'not-qris' }), key));
        assert.equal((await create(51001)).status, 503);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM orders').get().n, before);
        db.prepare("UPDATE payment_accounts SET credential=? WHERE user_id=1 AND provider='gopay'").run(credential);
        const created = await create(51001);
        assert.equal(created.status, 201, JSON.stringify(created.data));
        assert.equal(created.data.payment_origin, 'live');
        assert.equal(Object.hasOwn(created.data, "mock"), false);
        assert.equal(created.data.lab_unofficial, true);
        assert.equal(qris.getQrisField(created.data.qris_payload, '54'), '51001');
        assert.equal(qris.isValidQris(created.data.qris_payload), true);
        assert.equal((await create(51001)).status, 409);
        assert.equal((await create(1000)).status, 409); // lifetime amount non-reuse includes legacy
        const order = db.prepare('SELECT * FROM orders WHERE id=?').get(created.data.order_id);
        assert.equal(order.payment_origin, 'live');
        const account = db.prepare("SELECT * FROM payment_accounts WHERE user_id=1 AND provider='gopay'").get();
        const tx = { txid: 'SYNTHETIC-LIVE-CLAIM', amount: order.amount, time: Date.now() };
        for (const invalid of [{ amount: order.amount + 1 }, { time: order.created_at - 1 }, { time: Date.now() + 60000 }, { txid: '' }]) {
          assert.equal(handleLabTransaction(account, { ...tx, txid: 'INVALID-' + JSON.stringify(invalid), ...invalid }), false);
        }
        assert.equal(handleLabTransaction({ ...account, user_id: 2 }, tx), false);
        db.exec("CREATE TRIGGER fail_payment BEFORE UPDATE OF status ON orders BEGIN SELECT RAISE(ABORT,'test write failure'); END");
        assert.throws(() => handleLabTransaction(account, tx), /test write failure/);
        assert.equal(db.prepare('SELECT 1 FROM seen_transactions WHERE txid=?').get(tx.txid), undefined);
        db.exec('DROP TRIGGER fail_payment');
        assert.equal(handleLabTransaction(account, tx), true);
        assert.equal(handleLabTransaction(account, tx), false);
        assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status, 'paid');
        assert.equal(db.prepare('SELECT consumed_by FROM seen_transactions WHERE txid=?').get(tx.txid).consumed_by, order.id);
      } finally {
        config.labUnofficialEnabled = false;
        await new Promise(resolve => server.close(resolve));
      }
    });
    check('service state directory can be outside read-only source', () => {
      const r = readConfig('', { PAYGATE_DATA_DIR: path.join(temp, 'state'), DB_PATH: '' });
      assert.equal(r.value.dbPath, path.join(temp, 'state', 'paygate.db'));
    });
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    db.close();
  }
  console.log(`${checks} checks passed; isolated temp DB only`);
} finally {
  globalThis.fetch = nativeFetch;
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  rmSync(temp, { recursive: true, force: true });
}
