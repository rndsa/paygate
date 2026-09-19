# Login ShopeePay dari PayGate

## Alur pengguna

Klik **Hubungkan ShopeePay** lalu pilih salah satu dari dua metode:

**A. Login browser (disarankan).** PayGate membuka portal resmi Shopee Partner di browser server, mengisi form, dan mengirim satu permintaan login. Tidak perlu menyalin apa pun.

**B. Impor sesi (token B:).** Untuk pemilik instalasi yang sudah memegang sesi merchant sendiri. Tempel token inti `B:...`, ID merchant pembayaran, ID toko, dan payload QRIS statis milik akun yang sama.

### Login browser

1. Buka **Akun → Hubungkan ShopeePay** pada dashboard HTTPS milikmu.
2. Masukkan nomor handphone, username, atau email Shopee dan **password Shopee**. Kolom **Password PayGate (bukan Shopee)** terpisah untuk verifikasi ulang pemilik instalasi.
3. PayGate membuka portal resmi Shopee Partner dalam browser server baru, mengisi form, dan mengirim satu permintaan login. Jika portal meminta OTP yang didukung, isi OTP di PayGate. Tidak ada resend otomatis.
4. Jika sesi merchant dan daftar toko berhasil diverifikasi, pilih toko yang ditampilkan. Masukkan QRIS statis milik toko itu bila portal tidak menyediakan QRIS yang dapat diambil secara terverifikasi.
5. **Simpan saja** menyimpan sesi terenkripsi dalam keadaan belum aktif. **Simpan & aktifkan** menyimpan lalu meminta satu pengecekan feed terpisah; akun aktif hanya jika pengecekan lolos. Gagal berarti berhenti, bukan retry diam-diam.

Tidak perlu DevTools, menyalin cookie/token, atau mengisi ID merchant manual.

### Impor sesi (token B:)

1. Buka **Akun → Hubungkan ShopeePay → Saya sudah punya sesi (token B:)**.
2. Isi token inti, ID merchant pembayaran, ID toko, payload QRIS statis, dan password PayGate. Semua harus berasal dari akun yang sama.
3. **Simpan & aktifkan** menyimpan sesi terenkripsi lalu meminta satu pengecekan feed. Jalur ini hanya tersedia bagi pemilik instalasi (LAB owner) yang diaktifkan pengelola.

## Batas yang harus jelas

- Ini otomatisasi portal merchant privat, **bukan SDK resmi, partner resmi, atau sandbox pembayaran**. Izin dan ketentuan provider tetap berlaku.
- Bukti bahwa form resmi bisa dibuka bukan bukti login akun nyata berhasil. Perubahan portal, challenge, atau akses merchant yang tidak sesuai dapat menghentikan proses.
- CAPTCHA/persetujuan perangkat tidak dibypass. Saat muncul, PayGate menghentikan percobaan. Menyelesaikan verifikasi pada kanal resmi tidak menjamin percobaan browser baru akan diterima. Subframe/iframe dan redirect ke host di luar daftar terverifikasi diblokir; alur yang bergantung pada iframe belum didukung.
- Password/OTP hanya diproses sementara, tidak disimpan sebagai credential merchant, log, atau storage browser pengguna. Sesi hasil login disimpan terenkripsi di DB. Pengelola server tetap memegang kontrol atas proses dan kunci enkripsinya.
- Satu percobaan aktif, batas waktu lima menit, pembatasan persisten maksimal lima awal login per jam. Tunggu waktu yang ditampilkan; tidak ada loop kirim OTP.
- Pilihan toko berasal dari respons provider yang diverifikasi. Jika format atau scope tidak dapat dibuktikan, tidak ada akun diaktifkan. Token browser tidak pernah dikirim ke pengguna.
- Batas lokal sesi maksimal 12 jam tidak memperpanjang masa berlaku provider. Sesi kedaluwarsa memerlukan login ulang.
- Merchant/toko/QRIS yang sudah memiliki riwayat tidak boleh diganti diam-diam.

## Untuk deployer

Login memerlukan runtime Playwright/Chromium yang bisa dijalankan sebagai pengguna nonroot dengan sandbox browser. Lihat `BROWSER_RUNTIME.md`. Tidak tersedianya runtime harus ditampilkan sebagai hambatan nyata, bukan login pura-pura. Jangan menonaktifkan sandbox, memalsukan sidik perangkat, atau memasukkan telemetry hasil tangkapan.

Jangan kirim password, OTP, token, cookie, atau QRIS privat ke issue tracker. Laporan error cukup tahap, kode aman, waktu, dan tangkapan layar yang sudah disensor.
