# Brief koreksi pengguna — 8 September 2026

## Hasil yang diminta

Pengguna self-hosted memakai PayGate sebagai pengelola koneksi merchant, bukan alat yang menyerahkan pengambilan token kepada pengguna. Keberhasilan tes fixture/UI tidak membuktikan login merchant berhasil.

1. ShopeePay: identitas akun + PASSWORD merchant, proses sesi ditangani web, OTP/verifikasi bila provider meminta, daftar merchant/toko dipilih pengguna. DevTools, HAR, cookie manual dan impor token bukan alur utama yang diterima.
2. GoPay: investigasi penyebab OTP terus gagal dari tahap/status provider sebenarnya. Jangan hanya mengubah pesan error. Tidak boleh retry/resend otomatis setelah timeout/penolakan, menghapus cooldown, atau menganggap respons success berarti SMS terkirim.
3. MIT: halaman HTML visual, ringkasan hak/kewajiban/batas garansi, teks lisensi kanonis tetap utuh dan tersedia. Bukan menghapus lisensi atau menjadikannya klaim keamanan.
4. ToS: FAQ native accordion, ringkas per topik, ditujukan ke deployer, detail hukum/provider/credential tetap lengkap. Bukan tabel panjang pada tampilan default.
5. Saat masuk: popup persetujuan kecil di atas halaman login asli, latar inert, tidak memenuhi layar. Ringkasan risiko terlihat, checkbox wajib, accept/decline, link detail terpisah. Cookie/version/CSRF tetap.
6. Verifikasi: mobile 320/390, desktop/light-dark, focus/Tab/Escape, actual rendered content, akses lisensi/detail tanpa consent/login; full integration/security regressions; bukti live provider dipisah tegas dari simulasi.

## Batas implementasi

- Tidak menyimpan/log password provider, hash password wire, OTP, cookie/token/fingerprint/HAR. Hanya sesi hasil login tersimpan terenkripsi di server.
- Jika menggunakan browser: browser standar dengan isolasi per percobaan, tanpa stealth/spoof/replay telemetry; script provider sendiri menghasilkan pengukuran browser nyata. Challenge tidak dibypass.
- Tidak membuat form login palsu. Bila kontrak atau akses belum terbukti, laporkan hambatan dan jalur yang diperlukan dengan jujur. Tidak mengganti permintaan password-login diam-diam menjadi panduan DevTools lagi.
- Autentikasi ulang PayGate, CSRF, owner/admin/session/expiry binding, bounded request, durable cooldown, immutable merchant/history scope, strict order matching tetap.

## Status awal

Runtime flow1. Backup source `/root/paygate-backups/20260908T165338Z-pre-login-faq/source.tgz`. Journald tidak mencatat stage/status provider login; belum ada bukti akar masalah OTP dari log. Tidak ada upaya OTP/login baru dalam fase riset.
