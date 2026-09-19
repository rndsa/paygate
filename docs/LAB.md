# Panduan koneksi merchant — live-only

**Bukan sandbox atau integrasi resmi.** QRIS dapat memindahkan uang sungguhan. Gunakan hanya merchant milik sendiri dengan izin sesuai. Risiko ToS, challenge, penolakan sesi dan perubahan endpoint tetap ada. Tes lokal tidak membuktikan keberhasilan merchant nyata.

## Opt-in

Default `LAB_UNOFFICIAL=0`, `LAB_USER_ID` kosong. Tidak ada akun terhubung berarti order tidak bisa dibuat. Operator menetapkan ID user PayGate positif, bukan merchant ID, lalu opt-in setelah memahami risiko. Poll `LAB_POLL_INTERVAL_MS=60000`, minimum 30000. Tidak ada polling simulasi atau provider default.

GoPay dapat dihubungkan dari dashboard pemilik: nomor Indonesia, password PayGate untuk reauth, persetujuan risiko, OTP, discovery merchant, simpan pilihan. Hanya label dan ID pilihan opaque dikirim ke browser; token/QR discovery/merchant ID asli tetap server-side. Password bukan password GoPay. Jangan kirim password/OTP/token ke chat, log atau screenshot. Browser tidak menyimpan rahasia di localStorage/sessionStorage.

Penyimpanan sendiri menghasilkan **configured** (atau tetap paused), bukan active. **Simpan & aktifkan** meminta satu pengecekan feed setelah simpan, lewat API terpisah. Hapus centang pengecekan untuk **Simpan saja**; aktivasi berikutnya lewat **Aktifkan otomatis**. GET halaman/status tidak menghubungi upstream. **Jeda otomatis** menghentikan polling; aktivasi menghormati cooldown. Error/blocked/paused/unconfigured tidak membuka order. Server tetap otoritas jika UI kedaluwarsa.

ShopeePay: baca [panduan login](SHOPEE_CONNECT.md), buka **Login ShopeePay**, isi nomor/username/email, password Shopee, dan password PayGate untuk reauth. Browser server mengelola portal dan sesi; OTP bila diminta tahap yang didukung. Pilih toko dari hasil provider, masukkan QRIS milik toko bila belum tersedia. Tidak perlu DevTools atau token/ID merchant manual. CAPTCHA dan scope yang tidak terverifikasi menghentikan proses. Maksimal satu percobaan aktif, lima menit, lima awal login per jam; tanpa retry otomatis. Membutuhkan [runtime browser](BROWSER_RUNTIME.md) dengan sandbox.

## Konfigurasi server opsional

GoPay env: `GOPAY_ACCESS_TOKEN`, `GOPAY_MERCHANT_ID`, `GOPAY_QRIS_STATIC`. ShopeePay env: `SHOPEEPAY_TOKEN`, `SHOPEEPAY_MERCHANT_ID`, `SHOPEEPAY_STORE_ID`, `SHOPEEPAY_QRIS_STATIC`. Secret hanya dalam konfigurasi privat server atau formulir sesi khusus HTTPS, tidak Git. Akun dari dashboard memakai kredensial terenkripsi server-side. Perubahan operator/deploy dilakukan terpisah.

## Dana nyata

Provider wajib dipilih eksplisit. Maksimal Rp100.000/order; nominal tidak boleh dipakai ulang sepanjang riwayat provider. Konfirmasi nominal dan verifikasi diperlukan di dialog; rincian risiko tersedia di ToS. `paid` hanya cocok nominal, scope dan waktu: **verifikasi identitas transaksi di aplikasi merchant sebelum memenuhi order**. Nominal sama dari pihak lain dapat cocok. Timestamp presisi detik dapat ditahan tanpa pasangan: periksa manual; tidak ada tombol paksa paid.

Expiry, pause atau flag OFF tidak mencabut QR yang telah disalin dan bukan refund. QR/payload order selesai atau expired disembunyikan. Riwayat `legacy_unverified` tidak ditampilkan QR-nya, tidak dihitung live, tidak otomatis direkonsiliasi. Nama provider/CRC bukan bukti provenance nyata.

## Tes aman

```sh
node --test tests/ui.test.js
/root/camofox-venv/bin/python tests/ui_smoke.py
```

Smoke menyalin app ke direktori sementara, membuat DB baru, port localhost acak, LAB OFF dan kredensial provider kosong. Wizard memakai EJS asli + HTTP API fixture terisolasi di browser; menguji wiring, owner, busy, OTP, discovery, CSRF, storage dan mobile, bukan upstream. Tidak ada OTP nyata/pembayaran/deploy.

Riset kontrak privat dan keterbatasan dicatat di `GOPAY_LOGIN_RESEARCH.md` dan `SHOPEE_LOGIN_RESEARCH.md`. Referensi tidak berarti endorsement resmi.


Login GoPay hanya mendukung merchant satu outlet/POP; feed berscope merchant, bukan pemilihan bebas outlet. Scope merchant, outlet dan QR terkunci setelah ada riwayat. Sesi dashboard kedaluwarsa memblokir order/feed dan memerlukan hubungkan ulang manual.

GoPay memakai header tereduksi tanpa appId/version resmi, browser User-Agent, Origin atau Referer. Penerimaan server provider belum terverifikasi; 403/challenge ditampilkan sebagai gagal, tanpa spoof/bypass. Attempt login 5 menit; pengiriman dibatasi jeda 2 menit dan 5/jam. Kegagalan upstream minimal cooldown 15 menit, retry manual; tidak ada auto-refresh. Kredensial sumber dashboard tidak ditimpa impor environment. Shopee menggunakan browser server baru untuk login password; hasil tanpa bukti merchant/toko ditolak.
