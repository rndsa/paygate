// Measure what ACTUALLY reaches the wire with Node fetch vs axios.
// Zero provider network: localhost echo server only.
import { createServer } from 'node:http';

const srv = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ headers: req.headers, method: req.method, url: req.url }));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const url = `http://127.0.0.1:${port}/goid/login/request`;

const H = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'id',
  'Content-Type': 'application/json',
  'Authentication-Type': 'go-id',
  'Gojek-Country-Code': 'ID',
  'Gojek-Timezone': 'Asia/Jakarta',
  'Origin': 'https://portal.gofoodmerchant.co.id',
  'Referer': 'https://portal.gofoodmerchant.co.id/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'X-AppId': 'go-biz-web-dashboard',
  'X-AppVersion': 'platform-v3.111.0-1708bc9a',
  'X-DeviceOs': 'Web',
  'X-PhoneMake': 'Windows 10 64-bit',
  'X-PhoneModel': 'Chrome 150.0.0.0 on Windows 10 64-bit',
  'X-Platform': 'Web',
  'X-User-Locale': 'en-GB',
  'X-User-Type': 'merchant',
  'x-uniqueid': 'test-uuid-1234'
};
const body = JSON.stringify({ client_id: 'go-biz-web-new', phone_number: '81234567890', country_code: '62' });

const keys = ['user-agent', 'origin', 'referer', 'accept-language'];

console.log('=== Node fetch (what we use) ===');
const f = await fetch(url, { method: 'POST', headers: H, body, redirect: 'manual', credentials: 'omit' });
const fj = await f.json();
for (const k of keys) console.log(`  ${k}: ${JSON.stringify(fj.headers[k])}`);

let ax = null;
try { ax = (await import('axios')).default; } catch {}
if (ax) {
  console.log('=== axios (what repo uses) ===');
  const r = await ax.post(url, JSON.parse(body), { headers: H, timeout: 5000 });
  for (const k of keys) console.log(`  ${k}: ${JSON.stringify(r.data.headers[k])}`);
} else {
  console.log('=== axios NOT installed in paygate ===');
}

srv.close();
