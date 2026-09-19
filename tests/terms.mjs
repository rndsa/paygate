import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import express from 'express';
import ejs from 'ejs';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'paygate-terms-'));
process.env.PAYGATE_DATA_DIR = dataDir;
process.env.DB_PATH = path.join(dataDir, 'test.db');
process.env.LAB_UNOFFICIAL = '0';
process.env.COOKIE_SECRET = 'terms-test-secret-with-enough-entropy';
process.env.NODE_ENV = 'test';

const [{ default: termsRouter, hasTerms, requireTerms, TERMS_VERSION }, { parseCookies, csrf }, { ROOT }] = await Promise.all([
  import('../src/routes/terms.js'),
  import('../src/middleware/security.js'),
  import('../src/config.js'),
]);

assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?$/);
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
app.locals.config = { labUnofficialEnabled: false };
app.use(express.urlencoded({ extended: false }));
app.use(parseCookies, csrf);
app.use(termsRouter);
app.get('/proof', (req, res) => res.json({ accepted: hasTerms(req) }));
app.get('/protected', requireTerms, (req, res) => res.sendStatus(204));
app.post('/protected', requireTerms, (req, res) => res.sendStatus(204));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

async function get(url, options = {}) {
  const response = await fetch(base + url, { redirect: 'manual', ...options });
  return { response, text: await response.text() };
}
function cookiePair(setCookie) { return setCookie.split(';', 1)[0]; }
function csrfFrom(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1]; }

try {
  const page = await get('/terms?next=%2Fdashboard');
  assert.equal(page.response.status, 200);
  assert.match(page.text, /<dialog[^>]*id="termsDialog"[^>]*open[^>]*aria-labelledby="termsDialogTitle"/);
  assert.match(page.text, /class="auth-wrap"[^>]*inert/);
  assert.match(page.text, /Akun administrator/);
  assert.match(page.text, /Saya setuju &amp; lanjutkan/);
  assert.match(page.text, /src="\/static\/js\/terms\.js\?v=studio4n"/);
  assert.match(page.text, /href="\/terms\/details"[^>]*target="_blank"/);
  assert.equal(TERMS_VERSION, '2026-09-08-pw1', 'Server-handled merchant passwords require fresh consent');
  const tos = await ejs.renderFile(path.join(ROOT, 'views/pages/tos.ejs'));
  const detail = await get('/terms/details');
  assert.equal(detail.response.status, 200);
  for (const html of [tos, detail.text]) {
    assert.match(html, /<h1>Syarat Penggunaan<\/h1>/);
    assert.doesNotMatch(html, /<table\b|terms-table/);
    assert.match(html, /<details[^>]*class="terms-faq-item"/);
    assert.match(html, /Kamu.*source code.*server sendiri/s);
    assert.match(html, /Ketentuan dan tanggung jawab/);
    assert.match(html, /Persyaratan merchant ShopeePay/);
    for (const subject of ['TLS', 'domain', 'akses admin', 'enkripsi', 'backup']) assert.ok(html.includes(subject), subject);
    assert.match(html, /merchant milik sendiri atau yang sah dikuasakan/);
    assert.match(html, /bukan.*lisensi.*kekebalan hukum/s);
    assert.match(html, /tidak memberi izin baru/);
    assert.match(html, /Pembuat hanya menyediakan source code/);
    assert.match(html, /bukan operator instalasi.*penyimpan dana/s);
    assert.match(html, /dapat Kamu periksa dan audit sebelum deploy/);
    assert.match(html, /AS IS/);
    assert.match(html, /Kode sumber PayGate berlisensi <a href="\/license">MIT<\/a>/);
    assert.match(html, /Dependensi pihak ketiga tetap mengikuti lisensinya masing-masing/);
    assert.match(html, /tanpa jaminan keamanan/);
    assert.match(html, /bukan sertifikasi.*audit keamanan/s);
    assert.match(html, /Penyimpanan tidak membuktikan koneksi; pengecekan provider wajib sebelum aktif, hasil gagal berhenti/);
    assert.match(html, /Simpan &amp; aktifkan/);
    assert.match(html, /permintaan API terpisah/);
    assert.doesNotMatch(html, /\b(?:Carry|chat|lu|gua|pengguna)\b|Tes feed nyata wajib terpisah/i);
    const questions = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map(m => m[1]);
    assert.equal(questions.length, 9, 'Overview plus all eight legal topics use native FAQ');
    for (const topic of ['ShopeePay', 'GoPay/GoBiz', 'infrastruktur instalasi', 'sesi dan privasi', 'batas koneksi', 'pembayaran', 'batas tanggung jawab', 'persetujuan']) {
      assert.ok(questions.some(q => q.includes(topic)), topic);
    }
    assert.ok(questions.every(q => q.endsWith('?')), 'FAQ uses questions, not table labels');
    assert.match(html, /Shopee.*§5/s);
    assert.match(html, /§12\.2\(n\)/);
    assert.match(html, /persetujuan tertulis sebelumnya/i);
    assert.match(html, /merchant milik/i);
    assert.match(html, /verifikasi.*settlement/i);
    assert.match(html, /rahasia/i);
    assert.match(html, /tidak menjamin/i);
    assert.match(html, /hukum yang berlaku/i);
    assert.doesNotMatch(html, /\[object Promise\]/);
  }
  const popup = page.text.match(/<dialog[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(popup);
  assert.doesNotMatch(popup, /<details|<table|auth-card|dashboard-grid/);
  const risks = popup.match(/id="termsRisks"[^>]*>([\s\S]*?)<\/p>/)?.[1];
  assert.equal(risks?.match(/<br>/g)?.length, 1, 'Two short risk lines');
  assert.ok(risks.length < 100);
  assert.match(popup, /id="termsAccepted"[^>]*required/);
  assert.doesNotMatch(popup, /checked|method="dialog"/);
  assert.match(popup, /href="\/terms\?declined=1&amp;next=%2Fdashboard">Tidak setuju/);
  assert.doesNotMatch(page.text, /Persetujuan sekali/);
  assert.match(page.text, /180 hari; muncul lagi jika cookie hilang atau ketentuan berubah/);
  assert.match(popup, /blokir|suspend/i);
  assert.match(popup, /dana.*tahan|ditahan/i);
  assert.doesNotMatch(page.text, /LAB|UNOFFICIAL/);
  assert.match(page.text, new RegExp(`value="${TERMS_VERSION}"`));
  const csrfCookie = cookiePair(page.response.headers.get('set-cookie'));
  const token = csrfFrom(page.text);
  assert.ok(token);

  const declined = await get('/terms?declined=1&next=%2Fdashboard', { headers: { cookie: csrfCookie } });
  assert.equal(declined.response.status, 200);
  assert.match(declined.text, /belum disimpan/i);
  assert.equal(declined.response.headers.get('location'), null);
  assert.equal((await get('/proof', { headers: { cookie: csrfCookie } })).text, '{"accepted":false}');

  const redirect = await get('/protected?tab=orders');
  assert.equal(redirect.response.status, 303);
  assert.equal(redirect.response.headers.get('location'), '/terms?next=%2Fprotected%3Ftab%3Dorders');
  for (const invalidCsrf of ['', 'wrong-token']) {
    const rejected = await get('/terms/accept', { method: 'POST', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: invalidCsrf, version: TERMS_VERSION, accepted: 'yes' }) });
    assert.equal(rejected.response.status, 403);
    assert.ok(!rejected.response.headers.get('set-cookie')?.includes('paygate_terms='));
  }
  for (const body of [
    `_csrf=${token}&accepted=yes&version=old`,
    `_csrf=${token}&version=${TERMS_VERSION}`,
    `_csrf=${token}&accepted=on&version=old`,
    `_csrf=${token}&accepted=on`,
  ]) {
    const bad = await get('/terms/accept', { method: 'POST', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(bad.response.status, 422);
    assert.match(bad.text, /tidak dapat disimpan/i);
    assert.doesNotMatch(bad.text, /terms-test-secret/);
  }

  const unsafe = ['//evil.test', '/\\evil', '/terms', '/terms/accept', '/%74erms%2Faccept', '/%252f%252fevil.test', '/ok%0d%0aX:y'];
  for (const next of unsafe) {
    const accepted = await get('/terms/accept', {
      method: 'POST', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: token, accepted: 'yes', version: TERMS_VERSION, next }).toString(),
    });
    assert.equal(accepted.response.status, 303);
    assert.equal(accepted.response.headers.get('location'), '/login');
  }

  const accepted = await get('/terms/accept', {
    method: 'POST', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, accepted: 'yes', version: TERMS_VERSION, next: '/dashboard?tab=orders' }).toString(),
  });
  assert.equal(accepted.response.status, 303);
  assert.equal(accepted.response.headers.get('location'), '/dashboard?tab=orders');
  const setCookie = accepted.response.headers.get('set-cookie');
  assert.match(setCookie, /paygate_terms=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Max-Age=15552000/i);
  assert.doesNotMatch(setCookie, /Secure/i);
  const termsCookie = cookiePair(setCookie);
  assert.equal((await get('/proof', { headers: { cookie: `${csrfCookie}; ${termsCookie}` } })).text, '{"accepted":true}');

  const oldPayload=`2026-09-08-source-mit.${Date.now()+86400000}`;
  const oldProof=createHmac('sha256',process.env.COOKIE_SECRET).update(`paygate:terms:${oldPayload}`).digest('hex');
  assert.equal((await get('/proof', {headers:{cookie:`${csrfCookie}; paygate_terms=${oldPayload}.${oldProof}`}})).text,'{"accepted":false}');
  const [name, value] = termsCookie.split('=');
  const corrupt = `${name}=${value.slice(0, -1)}x`;
  assert.equal((await get('/proof', { headers: { cookie: `${csrfCookie}; ${corrupt}` } })).text, '{"accepted":false}');
  const denied = await get('/protected', { method: 'POST', headers: { cookie: csrfCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${token}` });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.response.headers.get('location'), null);
  assert.match(denied.text, /login belum diproses/);

  console.log('PASS terms: real HTTP; public content; decline; CSRF; explicit version/checkbox; signed cookie; safe return; corrupt refusal; gate.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
