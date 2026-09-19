# PayGate API — live-only

Integrasi unofficial, bukan sandbox. QRIS dapat memindahkan dana nyata. Contoh berikut kontrak, bukan hasil pembayaran nyata.

## Auth

Dashboard: cookie sesi dan `X-CSRF-Token` dari cookie `paygate_csrf` untuk mutasi. API order saja menerima `X-Api-Key`; key invalid/revoked tetap ditolak walaupun sesi valid. Akun/login, keys dan settings memerlukan sesi dashboard; kontrol merchant juga owner `LAB_USER_ID` + LAB enabled. Respons sensitif no-store. Jangan menaruh kredensial di URL, storage, chat atau log.

## Order

`POST /api/orders/create`

```json
{"provider":"gopay","amount":25000,"description":"Pesanan"}
```

Provider wajib `gopay` atau `shopeepay`, bukan default. Rupiah utuh positif maksimal 100000, deskripsi opsional maksimal 200 karakter. Akun configured, active dan telah divalidasi wajib; unavailable menghasilkan 503. Nominal yang pernah dipakai di provider sama tidak boleh dipakai ulang (409). Tidak ada idempotency key; jangan retry buta setelah timeout.

201 mencakup `order_id`, `provider`, `amount`, `status`, `expires_at`, QRIS payload/image, `payment_origin:"live"`, `lab_unofficial:true`.

- `GET /api/orders`: maksimal 50 order milik user.
- `GET /api/orders/:id/status`: status lokal, tanpa upstream. `paid` berarti cocok nominal/waktu/scope, bukan identitas pembayar. Verifikasi manual wajib.
- Riwayat `legacy_unverified`: QR/payload withheld, tidak dihitung sebagai live dan tidak direkonsiliasi otomatis. Status/txid lama bukan bukti settlement.
- QR hanya ditampilkan untuk provenance live, pending, belum expired. Expiry/pause tidak mencabut salinan QR.
- Tidak ada endpoint simulasi pembayaran.

## Pasang di website

Paket terpisah `examples/website.mjs` dan `docs/WEBSITE.md`: server checkout menyimpan API key dan harga, browser hanya menerima QR/status order miliknya. Jangan memanggil API dengan key dari JavaScript browser. Contoh localhost, satu proses, bukan storefront production; website tujuan belum diberikan. Tidak ada webhook/fulfillment otomatis atau klaim pembayaran nyata sudah berhasil.

## GoPay login dashboard

`GET /api/accounts` membaca metadata lokal saja:

```text
{accounts:[{provider,label,status,last_error,last_validated_at,next_poll_at}],
 lab:{enabled,owner,poll_interval_ms,providers:[{provider,configured,status}]},
 login:{gopay:{available,reason},shopeepay:{available,method:"browser_password",reason}},
 connection:{shopeepay:{available:<boolean>,method:"session_import"}}}
```

Semua POST berikut memakai sesi owner + CSRF, bukan API key:

| Route | Body tambahan (semuanya provider=gopay) | Berhasil |
|---|---|---|
| `/api/accounts/login/start` | `phone`, `password` PayGate (bukan GoPay), `consent:true` | `{ok:true,attempt_id,step:"otp",expires_at}` |
| `/api/accounts/login/verify` | `attempt_id`, `otp` | `{ok:true,attempt_id,step:"merchant",merchants:[{id,label}]}` |
| `/api/accounts/login/finish` | `attempt_id`, `merchant` (opaque choice ID) | `{ok:true,detail}` |
| `/api/accounts/login/cancel` | `attempt_id` | `{ok:true}` |

Attempt terikat sesi, user, provider dan expiry; tidak bisa dipakai lintas sesi. Error aman `{error,code}` tanpa raw upstream. Browser tidak menerima token, QR discovery, merchant/store ID asli. Password/OTP tidak disimpan; token berhasil terenkripsi server-side. Simpan menghasilkan configured, **bukan active**. UI **Simpan & aktifkan** meminta pengecekan feed satu kali melalui POST /api/accounts/test sesudah simpan; tanpa pilihan itu, aktivasi tetap manual.

## ShopeePay: login password browser server

POST `/api/accounts/shopee/login/start`: `{identifier,merchant_password,password,consent:true}`. Password PayGate untuk reauth terpisah dari password Shopee. POST `/verify`: `{attempt_id,otp}`. POST `/finish`: `{attempt_id,choice,qris_static}`. POST `/cancel`: `{attempt_id}`.

Start/verify menghasilkan `step:otp` atau `step:store` dengan `choices:[{id,label}]`; choice ID opaque, bukan ID merchant asli. Token/password/OTP tidak dikirim balik ke browser. Start/verify/finish memerlukan owner admin, sesi+CSRF, persetujuan terbaru; cancel tidak terhalang consent baru. Tidak ada resend otomatis atau bypass CAPTCHA.

Browser baru mengisi portal resmi dengan sandbox, lalu memverifikasi cookie sesi, profil merchant, dan scope daftar toko. Jika bukti tidak tersedia, gagal tertutup. Finish memvalidasi QRIS, mengenkripsi credential, mempertahankan cooldown dan scope riwayat; configured bukan active. Pilihan Simpan & aktifkan meminta satu feed check terpisah. Sesi maksimal 12 jam, dibatasi expiry provider yang lebih awal. Satu attempt aktif, TTL5 menit, maksimal lima awal login per jam. Endpoint importer `/api/accounts/shopee/connect` tersedia bagi pemilik instalasi (LAB owner) dan menerima `{token, merchant_id, store_id, qris_static, password}`; gated syarat+CSRF, satu attempt, rate-limited. Non-owner balas 403 tanpa mutasi.

Keberhasilan fixture/browser lokal bukan bukti login akun merchant nyata. [Panduan login](SHOPEE_CONNECT.md).

## ToS pertama kunjungan

`GET /terms`: popup ringkas di atas halaman login; `/terms/details` FAQ publik, `/tos` FAQ dashboard, `/license` lisensi MIT visual dan `/license.txt` teks asli; `POST /terms/accept`: form `{_csrf,version,accepted:"yes",next}`. Persetujuan versi 2026-09-08-pw1 disimpan di cookie HttpOnly bertanda tangan, SameSite=Lax, Secure di production, 180 hari; bukan login atau bukti merchant. GET/POST login dan halaman dashboard memerlukan persetujuan. API-key order, health, dan static tidak berubah. Tab `/tos` tetap dapat dibaca tanpa banner berulang. Hapus cookie/ganti browser/expiry/perubahan versi meminta ulang. ToS tidak menghapus hak/kewajiban hukum yang tidak boleh dikesampingkan.

## Kontrol dan metadata

- `POST /api/accounts/test`, `/pause`, `/resume`, body `{provider}`; owner + sesi + CSRF. Cooldown/lock server tetap berlaku. Test/resume melakukan HTTP feed nyata; GET tidak.
- Status: unconfigured, configured, active, paused, blocked, error. Hanya active tervalidasi boleh create.
- Poll nyata default 60000ms, minimum 30000ms. Error feed menghentikan background sampai tindakan manual. Tidak ada bypass challenge atau retry otomatis OTP.
- `GET /api/dashboard/summary`: metrik live terpisah dari legacy, bukan laporan settlement.
- `GET /api/transactions`: scoped, termasuk mutasi tanpa pasangan untuk verifikasi manual. Timestamp presisi detik dapat ambigu; tidak ada paksa paid.
- `GET /api/settings`: read_only, lab_enabled, poll_interval_ms nyata, payment_tolerance:0, order_ttl_minutes. Tidak ada default provider.
- API key: GET/POST `/api/api-keys`, POST `/:id/revoke` dan `/:id/regenerate`; key plaintext muncul sekali.
- POST `/change-password`, `/api/logout-all`; GET `/healthz` hanya status proses, bukan koneksi merchant.

Error: 401 auth; 403 CSRF/akses; 404 scope; 409 konflik; 410 pensiun/expired; 422 validasi; 429 cooldown; 503 unavailable; 500 internal. Body maksimal 32KB. Perhatikan rate limit sebelum polling.


Login GoPay hanya mendukung merchant satu outlet/POP; feed berscope merchant, bukan pemilihan bebas outlet. Scope merchant, outlet dan QR terkunci setelah ada riwayat. Sesi dashboard kedaluwarsa memblokir order/feed dan memerlukan hubungkan ulang manual.

GoPay memakai header tereduksi tanpa appId/version resmi, browser User-Agent, Origin atau Referer. Penerimaan server provider belum terverifikasi; 403/challenge ditampilkan sebagai gagal, tanpa spoof/bypass. Attempt login 5 menit; pengiriman dibatasi jeda 2 menit dan 5/jam. Kegagalan upstream minimal cooldown 15 menit, retry manual; tidak ada auto-refresh. Kredensial sumber dashboard tidak ditimpa impor environment. Shopee menggunakan browser server baru untuk login password; hasil tanpa bukti merchant/toko ditolak.
