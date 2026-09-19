# PayGate — Inspirasi dari `paygateme` (2026-09-10)

Sumber: `/root/skill-scrape/paygateme` (MIT, read-only — diekstrak, tidak dimodifikasi/dieksekusi). Blob device-fingerprint Shopee di-redact, tidak ada credential yang tersimpan di dokumen ini.

## Tujuan
Ambil 3 pola **provider-agnostic** dari repo itu, sesuaikan dengan PayGate (Node/Express/SQLite, login browser-based):

1. **Amount Allocator** — auto-pilih nominal unik (base+offset) supaya order concurrent tidak tabrakan. Saat ini PayGate menolak 409 kalau nominal pernah dipakai; dengan allocator, API bisa auto-allocate kalau client tidak menentukan amount eksak (atau base+offset).
2. **QRIS Analyzer / Test** — parse payload statis sebelum disimpan, tampilkan preview ringkas (merchant name, kota, acquirer hint, tipe static/dynamic), validasi checksum (NO-ECHO, hanya flag valid/invalid + field publik).
3. **Host split catatan** — untuk investigasi masa depan 401 GoPay `goid:error:unauthorized` (lihat §5); **tidak diimplementasikan** sekarang karena flow browser kita sudah menghindari path itu.

## Yang JANGAN di-port
- Direct Shopee Partner API (`api.partner.shopee.co.id`) — auth pakai cookie-JWT + device-fingerprint blob. Kami pakai **browser flow** (password+OTP di web partner) yang:
  - Tidak perlu device-fingerprint capture
  - Tidak menyimpan fingerprint shared (risiko fingerprint replay antar-akun)
  - Tidak mengangkangi ToS anti-fraud Shopee
- `RefreshSession` silent renewal — pakai OTP ulang kalau passport cookie expired.
- `cmd/login` CLI — tidak relevan untuk headless service.
- Pola `x-tob-token` (mobile app gateway) — bukan path kami.

## Desain implementasi

### Modul baru: `src/lib/amount-allocator.js`
```js
// Porting 1:1 dari payment/allocator.go
// Allocate(baseAmount, takenSet, {maxOffset=999}) -> {offset, uniqueAmount}
// takenSet: Set of whole-rupiah amounts that are currently active OR quarantined
// Quarantine window: 2 * clockSkew (60s) — amounts freed within last 2*skew cannot be reused
export function allocate(baseAmount, taken, opts = {}) {
  const max = Math.min(opts.maxOffset ?? 999, 999);
  if (!Number.isInteger(baseAmount) || baseAmount < 1) throw new Error('baseAmount invalid');
  if (!(taken instanceof Set)) throw new Error('taken must be a Set');
  for (let off = 1; off <= max; off++) {
    if (!taken.has(baseAmount + off)) return { offset: off, uniqueAmount: baseAmount + off };
  }
  const err = new Error(`No free unique slot for base ${baseAmount} (offset 1..${max} all claimed)`);
  err.code = 'AMOUNT_POOL_EXHAUSTED';
  throw err;
}
```

### Modul baru: `src/lib/qris-analyzer.js`
```js
// Baca tag publik dari QRIS statis sebelum disimpan.
// Field dikembalikan apa adanya — TIDAK ADA token/credential yang masuk ke sini.
// Output aman untuk UI (label merchant, kota, format IDR, CRC ok/fail).
export function analyzeQris(payload) {
  // 1. TLV parse (reuse parseQris dari lib/qris.js)
  // 2. Field publik: 00 (format), 01 (POI: 11=static, 12=dynamic), 26 (merchant PAN — masked),
  //    51 (IDR code 360), 52 (merchant category), 53 (transaction currency 360=IDR),
  //    54 (amount — kalau dynamic), 58 (country ID), 59 (merchant name), 60 (city),
  //    61 (postal), 62 (additional data — masked), 63 (CRC).
  // 3. Validasi CRC + cek 00=01 + 53=360 + 58=ID + 01=11 (static untuk disimpan).
  // 4. Masking PAN merchant: tampil 8 terakhir saja (mis "…12345678").
  // Return: {valid, type:'static'|'dynamic', merchantName, city, currency:'IDR',
  //          country:'ID', hasAmount, panMasked, crcValid, errors:[...]}
}
```

### Routes baru: `src/routes/qris.js` (mount di `/api/qris`)
- `POST /api/qris/analyze` (login required) — body `{payload}` ≤4096 char. Return analisis publik (NO-ECHO).
- `POST /api/qris/test-render` (login required, LAB owner only, `consent=true`) — body `{payload, amount}`. Validasi lalu render QR image dari dynamic-inject. Tujuan: "Test QRIS" untuk memastikan payload valid sebelum disimpan permanen. Tidak menyimpan ke DB, tidak membuat order.

### Audit/Console event baru (allowlist, NO-ECHO)
- `QRIS_ANALYZE` — module `shopeepay`/`gopay` (sesuai request), code enum.
- `QRIS_TEST_RENDER` — module `system`, code enum.
- Tambah ke catalogue `src/services/console-log.js`.

### Perubahan `src/routes/orders.js`
- `POST /api/orders/create` — kalau `body.amount` tidak dikirim, fallback ke `allocate(baseAmount=clientBaseAmount, taken)`. Body schema baru: `{provider, amount?, description?, base_amount?, auto_allocate?}`.
- Batas Rp100.000 (LAB) tetap di `uniqueAmount` final, bukan base.
- Tetep pakai INSERT dengan uniqueAmount — kalau nominal unique bentrok → allocator gagal → 503 dengan code `AMOUNT_POOL_EXHAUSTED`.

### Tests baru
- `tests/amount-allocator.mjs` — porting `qris_test.go` cases: allocator exhaust, taken-set collision, max offset bound, baseAmount validation.
- `tests/qris-analyzer.mjs` — static + dynamic + invalid + masking + CRC fail.
- `tests/qris-routes.mjs` — endpoint integration (auth/CSRF/tenant/rate-limit).

### UI kecil: tombol "Test QRIS" di modal Shopee finish-step
- Side-button kecil di samping textarea `spQris` → fetch `/api/qris/analyze` → tampil panel: merchant, kota, static/dynamic, CRC status.
- Tidak ada client-side rendering QR sebelum user konfirmasi "Simpan".

## Constraint tetap
- Tidak ada provider testing boros. Analyzer pure local — tidak ada HTTP call ke provider.
- Tidak ada credential log. Field merchant PAN dimasking sebelum sampai ke UI/log.
- Tidak ada bypass ToS. Test render opsional butuh consent.
- Cooldown deploy terjaga: deploy code-only, ENV/DB tidak disentuh.
- Tidak ada perubahan ke flow login (browser-based tetap).

## Out of scope (future work, tidak sekarang)
- Investigasi `goid:error:unauthorized` via host split ke `api.gojekapi.com` — perlu lab test dummy, bukan production credential.
- Device-fingerprint capture untuk Shopee — ditolak (risiko akun).
- Static QRIS injection tag-26 (merchant PAN swap) — bukan fitur, hanya guard keamanan.
