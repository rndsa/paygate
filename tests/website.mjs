// Synthetic upstream only: these checks do NOT prove GoPay/payment processing works.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
const key = 'synthetic-server-only-secret';
let creates = 0, mode = 'live', lastBody, upstreamCookie;
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const upstream = createServer(async (req, res) => {
  assert.equal(req.headers['x-api-key'], key);
  upstreamCookie = req.headers.cookie;
  if (req.method === 'POST') {
    creates++;
    let body = ''; for await (const part of req) body += part;
    lastBody = JSON.parse(body);
  }
  if (mode === 'error') { res.writeHead(500); return res.end(key); }
  if (mode === 'redirect') { res.writeHead(302, { location: '/steal' }); return res.end(); }
  if (mode === 'oversized') return res.end('x'.repeat(1024 * 1024 + 1));
  if (mode === 'malformed') return res.end('{broken');
  if (mode === 'timeout') return;
  const badIds = { missing_id: undefined, null_id: null, numeric_id: 7, array_id: ['order-1'] };
  const id = Object.hasOwn(badIds, mode) ? badIds[mode] : req.method === 'POST' ? `order-${creates}` : req.url.split('/')[3];
  res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ order_id: id, provider: 'gopay', payment_origin: mode === 'fake' ? 'mock' : 'live', lab_unofficial: true, amount: 25000, expires_at: mode === 'expired' ? Date.now() - 1 : Date.now() + 60000, status: 'pending', qris_payload: '<script>alert(1)</script>', qris_image: image, secret: key }));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(r => reserve.close(r));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['examples/website.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PAYGATE_URL: `http://127.0.0.1:${upstream.address().port}`, PAYGATE_API_KEY: key, PRICE_IDR: '25000' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const request = async (path, options = {}) => {
  const response = await fetch(base + path, options);
  const text = await response.text(); assert.ok(!text.includes(key), 'secret never sent to browser');
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
};
const checkout = (cookie, headers = {}, body = '{"amount":1,"provider":"evil"}') => request('/checkout', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}), ...headers }, body });
try {
  const deadline = Date.now() + 4000;
  while (true) {
    try { await fetch(base); break; } catch { if (Date.now() > deadline || child.exitCode !== null) throw Error(`server startup failed: ${logs}`); await new Promise(r => setTimeout(r, 20)); }
  }
  const page = await request('/');
  assert.match(page.text, /unofficial|tidak resmi/i);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(page.headers.get('set-cookie'), /HttpOnly/); assert.match(page.headers.get('set-cookie'), /SameSite=Lax/);
  const js = await request('/app.js'); assert.match(js.text, /textContent/); assert.ok(!js.text.includes('innerHTML'));
  assert.equal((await checkout(cookie, { origin: '' })).status, 403);
  assert.equal((await checkout(cookie, { origin: 'https://evil.example' })).status, 403);
  const badHost = await new Promise((resolve, reject) => { const req = httpRequest(base + '/checkout', { method: 'POST', headers: { host: 'evil.example', origin: base, cookie, 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end('{}'); });
  assert.equal(badHost, 403);
  assert.equal((await checkout(cookie, {}, 'x'.repeat(4097))).status, 413);
  assert.equal((await checkout(cookie, {}, '{bad')).status, 400);
  const [first, second] = await Promise.all([checkout(cookie), checkout(cookie)]);
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  assert.equal(creates, 1, 'concurrent checkout creates once');
  assert.equal(first.json().order_id, second.json().order_id);
  assert.equal(lastBody.amount, 25000); assert.equal(lastBody.provider, 'gopay'); assert.equal(upstreamCookie, undefined);
  assert.equal((await checkout(cookie)).json().order_id, first.json().order_id); assert.equal(creates, 1);
  assert.equal((await request('/status')).status, 401);
  const other = (await request('/')).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/status?order_id=' + first.json().order_id, { headers: { cookie: other } })).status, 404);
  assert.equal((await request('/status', { headers: { cookie: cookie + '; attacker=1' } })).json().order_id, first.json().order_id);
  mode = 'fake'; assert.equal((await request('/status', { headers: { cookie } })).status, 502);
  mode = 'expired'; const expired = (await request('/status', { headers: { cookie } })).json(); assert.equal(expired.status, 'expired'); assert.equal(expired.qris_image, undefined);
  for (const failure of ['missing_id', 'null_id', 'numeric_id', 'array_id', 'error', 'fake', 'redirect', 'oversized', 'malformed', 'timeout']) {
    mode = failure;
    const buyer = (await request('/')).headers.get('set-cookie').split(';')[0];
    const before = creates;
    assert.equal((await checkout(buyer)).status, 502);
    assert.equal((await checkout(buyer)).status, 409, 'ambiguous create must not automatically retry');
    assert.equal(creates, before + 1);
  }
  assert.equal((await request('/checkout', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  for (const invalid of [{ HOST: '0.0.0.0' }, { PRICE_IDR: '100001' }, { PRICE_IDR: '1.5' }, { PAYGATE_API_KEY: '' }, { PAYGATE_URL: 'http://example.com' }, { PAYGATE_URL: 'https://user:pass@example.com' }, { PAYGATE_URL: 'https://example.com/api' }]) {
    const result = spawnSync(process.execPath, ['examples/website.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PAYGATE_API_KEY: key, PAYGATE_URL: 'https://example.com', ...invalid }, timeout: 1000 });
    assert.equal(result.status, 1, 'unsafe config rejected before listen');
  }
  assert.ok(!logs.includes(key));
  console.log('PASS website: real HTTP; synthetic upstream; trusted price; CSRF/size; cookie ownership; secret filtering; live-only; expiry; concurrent dedup; fail-closed/no retry. No live providers called.');
} finally {
  child.kill(); if (child.exitCode === null) await once(child, 'exit');
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
}
