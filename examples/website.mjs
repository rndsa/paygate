import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const price = Number(process.env.PRICE_IDR || 25000);
const key = process.env.PAYGATE_API_KEY;
const loopback = value => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(value);
let upstream;
try { upstream = new URL(process.env.PAYGATE_URL); } catch { throw Error('PAYGATE_URL required: HTTPS origin, or loopback HTTP for local tests'); }
if (!loopback(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('HOST must be loopback; PORT must be 1..65535');
if (!Number.isInteger(price) || price < 1 || price > 100000) throw Error('PRICE_IDR must be integer 1..100000');
if (!key || /[\r\n]/.test(key)) throw Error('PAYGATE_API_KEY required, server environment only');
if (upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash || !(upstream.protocol === 'https:' || (upstream.protocol === 'http:' && loopback(upstream.hostname)))) throw Error('PAYGATE_URL must be HTTPS origin; HTTP only for loopback');
const authority = `${host.includes(':') ? '[' + host.replace(/[\[\]]/g, '') + ']' : host}:${port}`;
const origin = `http://${authority}`;
// ponytail: one process, 1000 buyers, 30-minute volatile sessions; persistent carts + reconciliation needed before production.
const buyers = new Map(), ttl = 30 * 60 * 1000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const prune = () => { for (const [id, buyer] of buyers) if (buyer.until <= Date.now()) buyers.delete(id); };
setInterval(prune, 60000).unref();
async function bounded(stream, maximum) {
  let size = 0; const chunks = [];
  for await (const part of stream) { size += part.length; if (size > maximum) throw fail(413, 'Request too large'); chunks.push(Buffer.from(part)); }
  return Buffer.concat(chunks).toString('utf8');
}
async function api(path, body) {
  try {
    const response = await fetch(new URL(path, upstream), { method: body ? 'POST' : 'GET', headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw Error('upstream status'); }
    return JSON.parse(await bounded(response.body, 1024 * 1024));
  } catch { throw fail(502, 'PayGate tidak dapat diverifikasi. Jangan ulangi pembayaran; periksa dashboard merchant.'); }
}
function safeOrder(data, expectedId) {
  if (!data || data.payment_origin !== 'live' || data.mock === true || data.provider !== 'gopay' || data.amount !== price || typeof data.order_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.order_id) || (expectedId && data.order_id !== expectedId) || !['pending', 'paid', 'expired', 'failed', 'cancelled'].includes(data.status) || !Number.isSafeInteger(data.expires_at) || data.expires_at <= 0) throw fail(502, 'Respons pembayaran tidak valid.');
  const status = data.status === 'pending' && data.expires_at <= Date.now() ? 'expired' : data.status;
  const order = { order_id: data.order_id, provider: 'gopay', payment_origin: 'live', amount: price, status, expires_at: data.expires_at };
  if (status === 'pending') {
    if (typeof data.qris_image !== 'string' || data.qris_image.length > 900000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.qris_image)) throw fail(502, 'QR pembayaran tidak valid.');
    order.qris_image = data.qris_image;
  }
  if (JSON.stringify(order).includes(key)) throw fail(502, 'Respons pembayaran tidak valid.');
  return order;
}
const page = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Checkout PayGate</title><script src="/app.js" defer></script><main><h1>Checkout</h1><p>Total: Rp ${price.toLocaleString('id-ID')}</p><p>Integrasi GoPay unofficial / tidak resmi. Status koneksi atau Test bukan bukti pembayaran berhasil.</p><button id="checkout" type="button">Buat pembayaran GoPay</button><p id="status" role="status" aria-live="polite">Belum ada pembayaran.</p><img id="qr" alt="QRIS pembayaran" width="280" height="280" hidden><p>Pembayaran tidak otomatis mengirim barang. Merchant harus memverifikasi pesanan dan pemenuhan terpisah.</p></main></html>`;
const script = `const button = document.getElementById('checkout'), status = document.getElementById('status'), qr = document.getElementById('qr');
let order, busy = false;
function hide() { qr.hidden = true; qr.removeAttribute('src'); }
function show(data) {
  order = data; hide(); button.disabled = true;
  const expired = data.status === 'pending' && data.expires_at <= Date.now();
  status.textContent = 'Status pembayaran: ' + (expired ? 'expired' : data.status) + '. Pengiriman diverifikasi merchant terpisah.';
  if (!expired && data.status === 'pending' && data.payment_origin === 'live' && data.qris_image) { qr.src = data.qris_image; qr.hidden = false; }
}
async function read(path, options) {
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Pembayaran tidak dapat diverifikasi.');
  return data;
}
button.addEventListener('click', async () => {
  if (busy || order) return; busy = true; button.disabled = true; hide();
  try { show(await read('/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })); }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; }
});
async function poll() {
  if (busy || (order && order.status !== 'pending')) return;
  busy = true;
  try { const response = await fetch('/status', { signal: AbortSignal.timeout(10000) }); if (response.status === 404 && !order) return; const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Status tidak dapat diverifikasi.'); show(data); }
  catch (error) { hide(); status.textContent = error.message; }
  finally { busy = false; }
}
setInterval(() => { if (order && order.status === 'pending' && order.expires_at <= Date.now()) { hide(); status.textContent = 'Pembayaran kedaluwarsa. Jangan gunakan QR lama.'; } }, 500);
setInterval(poll, 5000); poll();`;

const server = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, data, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
  try {
    if (req.headers.host !== authority) throw fail(403, 'Host tidak diizinkan.');
    const path = new URL(req.url, origin).pathname;
    prune();
    const cookies = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith('paygate_buyer='));
    const id = cookies.length === 1 ? cookies[0].slice('paygate_buyer='.length) : '';
    let buyer = /^[a-f0-9]{48}$/.test(id) ? buyers.get(id) : undefined;
    if (req.method === 'GET' && path === '/') {
      if (!buyer) {
        if (buyers.size >= 1000) throw fail(503, 'Terlalu banyak sesi.');
        const token = randomBytes(24).toString('hex'); buyer = { until: Date.now() + ttl }; buyers.set(token, buyer);
        res.setHeader('Set-Cookie', `paygate_buyer=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1800`);
      }
      return send(200, page, 'text/html');
    }
    if (req.method === 'GET' && path === '/app.js') return send(200, script, 'text/javascript');
    if (req.method === 'POST' && path === '/checkout') {
      if (req.headers.origin !== origin) throw fail(403, 'Origin tidak diizinkan.');
      if (!buyer) throw fail(401, 'Buka halaman checkout untuk sesi baru.');
      if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw fail(415, 'JSON required');
      if (Number(req.headers['content-length'] || 0) > 4096) throw fail(413, 'Request too large');
      let input; try { input = JSON.parse(await bounded(req, 4096)); } catch (error) { if (error.status) throw error; throw fail(400, 'JSON tidak valid.'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'JSON object required');
      if (buyer.creating) return send(200, await buyer.creating);
      if (buyer.order) return send(200, safeOrder(buyer.order));
      if (buyer.attempted) throw fail(409, 'Pembuatan sebelumnya tidak pasti. Periksa dashboard; jangan ulangi.');
      buyer.attempted = true;
      buyer.creating = (async () => { const order = safeOrder(await api('/api/orders/create', { provider: 'gopay', amount: price, description: 'Website checkout' })); buyer.order = order; return order; })();
      try { return send(200, await buyer.creating); } finally { buyer.creating = null; }
    }
    if (req.method === 'GET' && path === '/status') {
      if (!buyer) throw fail(401, 'Sesi tidak valid.');
      if (!buyer.order) throw fail(buyer.attempted ? 409 : 404, buyer.attempted ? 'Pembuatan tidak pasti. Periksa dashboard.' : 'Belum ada pesanan.');
      buyer.order = safeOrder(await api(`/api/orders/${encodeURIComponent(buyer.order.order_id)}/status`), buyer.order.order_id);
      return send(200, buyer.order);
    }
    send(404, { error: 'Not found' });
  } catch (error) { if (!res.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Kesalahan server.' }); else res.destroy(); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(port, host, () => console.log(`Website: ${origin} (unofficial; no fulfillment)`));
