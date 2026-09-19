# Website checkout terpisah (Node.js 24)

Contoh siap dijalankan, **belum dipasang ke website Anda** karena website belum ditentukan. Tidak mengubah dashboard, deployment, atau aplikasi utama. Tanpa dependency tambahan.

## Jalankan

1. Login dashboard merchant PayGate. Hubungkan akun GoPay dengan OTP, lalu pilih **Simpan & aktifkan**. Pengecekan feed dijalankan sekali sesudah penyimpanan; hasilnya bukan bukti pembayaran berhasil.
2. Ambil API key merchant dari dashboard. Simpan hanya di environment server; jangan taruh pada HTML, browser JavaScript, URL, atau repository.
3. Jika mengunduh `website.mjs` dari dashboard, simpan sebagai `examples/website.mjs` di folder kerja. Dari root folder itu, jalankan (ganti origin dan masukkan key secara privat):

```bash
export PAYGATE_URL='https://paygate.example.com'
read -r -s -p 'API key merchant: ' PAYGATE_API_KEY; printf '\n'
export PAYGATE_API_KEY
export PRICE_IDR=25000
node examples/website.mjs
```

Buka `http://127.0.0.1:3001`. `PORT` opsional, default `3001`; `HOST` opsional, hanya `127.0.0.1`, `localhost`, atau `::1`. Gunakan hostname persis seperti URL startup; Host/Origin lain ditolak. `PAYGATE_URL` harus origin HTTPS tanpa path/query/credential; HTTP hanya diizinkan untuk loopback pengujian lokal. `PRICE_IDR` integer 1–100000, default 25000. Harga/provider dari browser diabaikan, tidak ada perubahan nominal otomatis.

## Alur dan batas

- Browser mengambil halaman dan `/app.js` dari server contoh. CSP hanya mengizinkan script sendiri, QR PNG data URL, tanpa script inline. Pesan memakai `textContent`.
- Tombol mengirim `POST /checkout` JSON, Origin/Host harus cocok persis; body maksimum 4096 byte. Server memanggil `/api/orders/create` dengan `X-Api-Key`, `provider: gopay`, dan harga server. API key dan cookie merchant tidak dikirim ke browser; cookie pembeli opaque dibuat server, HttpOnly, SameSite=Lax. Cookie pembeli tidak diteruskan ke PayGate.
- `GET /status` hanya membaca order milik cookie pembeli dari Map server. Parameter order dari browser tidak dipakai. Respons difilter, wajib `payment_origin: live`, provider/nominal/ID/status valid. QR hanya PNG data URL, disembunyikan saat non-pending, kedaluwarsa, atau status gagal diverifikasi.
- Checkout paralel/berulang pada sesi sama menggunakan satu order. Kegagalan create dianggap ambigu dan dikunci dalam sesi; jangan ulangi pembayaran sebelum cek dashboard. Upstream timeout 8 detik, tanpa retry atau redirect. UI memeriksa status setiap 5 detik, bukan mengulang create.
- Nominal persis bisa mendapat 409 karena aturan keunikan nominal PayGate sepanjang umur. Contoh tidak menambahkan biaya/angka unik diam-diam; periksa dashboard dan kebijakan harga merchant.
- **Integrasi GoPay unofficial / tidak resmi.** Tidak ada klaim pembayaran live sudah diuji, webhook, pengiriman barang, atau fulfillment otomatis. Status paid bukan instruksi kirim otomatis.
- `ponytail:` satu proses localhost, maksimum 1000 sesi, TTL 30 menit. Restart/TTL menghapus mapping; jangan membuat ulang order tanpa rekonsiliasi dashboard. Satu sesi satu checkout, termasuk setelah paid/expired. Cookie tanpa Secure hanya karena contoh HTTP loopback. Jangan expose langsung ke internet atau lewat proxy: produksi butuh HTTPS + Secure cookie, origin publik eksplisit, autentikasi/cart persisten, rate limit, idempotensi lintas restart/sesi, rekonsiliasi dan alur fulfillment terverifikasi. Contoh bukan sistem commerce produksi.

## Tes

```bash
node --check examples/website.mjs
node tests/website.mjs
```

Tes menjalankan server website nyata melalui HTTP dan **upstream PayGate sintetis lokal** untuk kontrak transport. Tidak menghubungi GoPay/provider live. Mencakup harga server meski body dipalsukan, kepemilikan cookie, tidak bocor API key, CSRF Origin/Host, batas body, pesan aman, deduplikasi paralel, expiry QR, live-only, dan error/redirect fail-closed tanpa retry create. Tes ini bukan bukti pembayaran nyata berhasil.
