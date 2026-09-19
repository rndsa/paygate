# GoPay: API resmi, onboarding, OAuth merchant, pemilihan outlet

Tanggal riset: 2026-09-08 UTC. Metode: GET dokumentasi publik resmi saja. Tidak membaca `.env`, kredensial, DB, atau sesi browser; tidak mengirim login, OTP, token exchange, linking, ataupun transaksi. Status di bawah = kontrak dokumentasi terverifikasi, **bukan** hasil uji akun PayGate.

## Keputusan

- **OAuth merchant resmi ada: GoBiz Facilitator Authorization Code.** Merchant login/OTP di halaman Gojek, kembali ke PayGate dengan authorization code. Bukan form password/OTP GoBiz milik PayGate. [Auth](https://developer.gobiz.com/docs/api/auth/facilitator/authorization-code)
- **Selector outlet resmi ada:** token-info mengembalikan `data.outlets`; merchant memilih outlet yang memang dapat diakses, lalu integrasi menautkan outlet tersebut ke produk `payment`. Bukan enumerasi seluruh merchant dengan nomor telepon/password. [Token info](https://developer.gobiz.com/docs/api/outlet-information/get-authenticated-outlet-information), [Link by ID](https://developer.gobiz.com/docs/api/outlet-information/link-outlet-by-id)
- **Terima pembayaran baru:** Midtrans Core API QRIS paling praktis untuk checkout PayGate; GoBiz Payment API lebih sesuai bila syaratnya menghubungkan merchant/outlet GoBiz yang sudah ada lewat OAuth. Keduanya perlu onboarding/kredensial resmi. Ini rekomendasi desain, bukan jaminan persetujuan provider.
- `AUTH_REJECTED` pada login OTP privat tidak terdiagnosis oleh riset dokumentasi. Mengganti client ID aplikasi, header, atau meniru perangkat bukan migrasi resmi. Tidak ada bypass yang diuji atau direkomendasikan.

## 1. GoBiz: onboarding dan kontrak OAuth

GoBiz mendukung **Direct Integration** (merchant memakai sistem sendiri) dan **Facilitator** (POS/aggregator melayani merchant). Kredensial OAuth berupa `client_id` dan `client_secret` terbitan Gojek, diperoleh melalui GoBiz Developer Portal. Portal menyatakan developer ditunjuk memakai email pemilik yang terdaftar di GoBiz; setelah pengujian integrasi, tim GoBiz melakukan verifikasi sebelum live. [Model](https://developer.gobiz.com/docs/api/intro/index.html), [Kredensial](https://developer.gobiz.com/docs/docs/authentication/index.html), [Portal](https://developer.gobiz.com/)

Jalur onboarding: https://developer.gobiz.com/ ; kontak integrasi/aktivasi: https://developer.gobiz.com/contact-us . Halaman kontak berhasil GET, form tidak dikirim.

| Lingkungan | OAuth base | API base |
|---|---|---|
| Sandbox | `https://integration-goauth.gojekapi.com` | `https://api.partner-sandbox.gobiz.co.id` |
| Production | `https://accounts.go-jek.com` | `https://api.gobiz.co.id` |

Sumber base URL: [API intro](https://developer.gobiz.com/docs/api/intro/index.html).

### Delegasi merchant dan pemilihan outlet

1. Daftarkan callback/redirect URI dan kredensial **milik integrasi PayGate**, dengan grant/scope yang disetujui provider.
2. Redirect browser ke `GET {OAUTH_URL}/oauth2/auth`. Parameter wajib: `client_id`, `response_type=code`, `scope` minimal `openid`, `state`, `redirect_uri` terdaftar, `user_type=merchant`. Minta `partner:outlet:read` untuk discovery/linking; `offline` bila refresh token diperlukan. `prompt=login` tersedia untuk memilih/login akun berbeda. Merchant memasukkan kredensial pada **halaman Gojek**.
3. Callback membawa `code` dan `state`; validasi state terikat sesi. Code sekali pakai, kedaluwarsa dua menit. Backend menukar melalui `POST {OAUTH_URL}/oauth2/token`, form URL-encoded: `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`. Simpan secret/token di server.
4. Dengan token Authorization Code, panggil `GET {API_BASE}/integrations/partner/v1/token-info`, scope `partner:outlet:read`. Respons berisi `data.user.roles` dan `data.outlets[]` dengan `id`, `name`, `address`. Elemen pertama outlet utama; `email`/`phone` deprecated dan kosong.
5. Tampilkan selector dari hasil tersebut saja. Link pilihan memakai `PUT {API_BASE}/integrations/partner/outlets/{outlet_id}/v1/link/payment`, body `{"external_outlet_id":"ID-outlet-PayGate"}`. Wajib user memiliki akses outlet, role `owner`, `admin`, atau `manager`, token Authorization Code scope `partner:outlet:read`.
6. Untuk daftar outlet **yang sudah ditautkan ke integrasi**, gunakan token Client Credentials scope `partner:outlet:read`, `GET {API_BASE}/integrations/partner/v1/linked-outlets`; pagination `per`, `page`.

Sumber kontrak: [Authorization Code](https://developer.gobiz.com/docs/api/auth/facilitator/authorization-code), [Token info](https://developer.gobiz.com/docs/api/outlet-information/get-authenticated-outlet-information), [Link by ID](https://developer.gobiz.com/docs/api/outlet-information/link-outlet-by-id), [Linked outlets](https://developer.gobiz.com/docs/api/outlet-information/get-all-outlets).

**Jangan pakai endpoint linking lama** `PUT /integrations/partner/v1/outlet-link` untuk selector multi-outlet: dokumentasi memperingatkan endpoint itu hanya menautkan outlet utama. [Peringatan](https://developer.gobiz.com/docs/api/outlet-information/link-outlet/)

Token default hidup 3600 detik. Refresh memerlukan grant `refresh_token`, kredensial client, dan refresh token yang diterbitkan dengan scope `offline`. Dokumentasi menyebut sesi Authorization Code berakhir setelah sembilan bulan; harus autentikasi ulang melalui alur resmi. Ini berbeda dari kredensial Client Credentials untuk operasi M2M. [Auth](https://developer.gobiz.com/docs/api/auth/facilitator/authorization-code)

## 2. GoBiz Payment API: menerima QRIS

Operasi pembayaran memakai token **Client Credentials**, bukan password/OTP merchant:

| Operasi | Endpoint relatif ke API base | Scope |
|---|---|---|
| Buat QRIS dinamis | `POST /integrations/payment/outlets/{outlet_id}/v2/transactions` | `payment:transaction:write` |
| Status/detail transaksi | `GET /integrations/payment/outlets/{outlet_id}/v1/transactions/{id}` | `payment:transaction:read` |

Create: `Authorization: Bearer {access_token}`, `Content-Type: application/json`, **`Idempotency-Key` wajib, maksimal 32 karakter**. Body berisi `payment_type: "qris"`, `transaction_details` dengan `order_id`, `gross_amount`, `currency: "IDR"`; item/customer optional. Respons `data.transaction` mencakup `id`, `status`, `qris_string`, `order_id`, jumlah; `data.actions` menyertakan URL QR. [Create](https://developer.gobiz.com/docs/api/payment-integration/create-transaction), [Get detail](https://developer.gobiz.com/docs/api/payment-integration/get-transaction)

QRIS dapat dibayar aplikasi kompatibel QRIS, bukan GoPay saja. [Payment overview](https://developer.gobiz.com/docs/api/payment-integration/)

**Inkonsistensi dokumentasi:** contoh create/get masih memakai `https://api.sandbox.gobiz.co.id`, sedangkan tabel environment menyebut `https://api.partner-sandbox.gobiz.co.id`. Gunakan environment yang diberikan saat onboarding; konfirmasikan host sandbox sebelum implementasi live. Tidak diuji dengan kredensial.

## 3. Midtrans: pilihan checkout resmi paling sederhana

Daftar merchant https://dashboard.midtrans.com/register . Perlu email/telepon valid, lengkapi aktivasi/KYC dan pengaturan akun. Dokumentasi KYC menyebut individu domestik KTP + NPWP; badan usaha antara lain akta terbaru, pengesahan kementerian, identitas/NPWP direktur, NPWP perusahaan, NIB/SIUP/TDP serta izin sesuai usaha. Persyaratan final mengikuti jenis usaha dan verifikasi provider. [Akun](https://docs.midtrans.com/reference/midtrans-account), [KYC](https://docs.midtrans.com/docs/what-are-the-legal-documents-required-for-midtrans-account-registration)

API keys diperoleh dari dashboard **Settings > Access Keys**; berbeda per merchant dan environment. `Server Key` rahasia backend; `Client Key` untuk frontend bila produknya memerlukan. QRIS Core API backend tidak menggunakan password dashboard. [Akun](https://docs.midtrans.com/reference/midtrans-account)

Kontrak QRIS:

- Backend `POST https://api.midtrans.com/v2/charge` untuk production.
- Header `Authorization: Basic base64(ServerKey + ":")`, `Content-Type: application/json`, `Accept: application/json`.
- Body minimum `{"payment_type":"qris","transaction_details":{"order_id":"ID-unik-PayGate","gross_amount":10000}}` — contoh kontrak, **tidak dikirim**.
- Respons memuat `merchant_id`, `transaction_id`, `transaction_status`, `qr_string`, action URL `generate-qr-code`.
- Gunakan HTTP notification untuk perubahan status; status API sebagai fallback. Guide POS menyebut `X-Override-Notification` untuk tujuan webhook partner. Penandaan lunas harus berdasarkan notifikasi/status yang diverifikasi backend, bukan callback browser.

Sumber: [QRIS POS integration](https://docs.midtrans.com/docs/gopay-qris-pos-integration), [Authorization](https://docs.midtrans.com/docs/api-authorization-headers).

**Pemilihan akun:** auth Midtrans menentukan merchant ID dari Server Key. Riset ini tidak menemukan kontrak publik untuk login dashboard merchant via password/OTP di PayGate dan mengambil semua merchant ID. Selector lokal hanya boleh memilih konfigurasi merchant yang telah diotorisasi; skema facilitator/multi-merchant perlu kesepakatan Midtrans, bukan berbagi satu key atau mengganti field merchant ID. [Authorization](https://docs.midtrans.com/docs/api-authorization-headers)

**Bukan login merchant:** Midtrans GoPay Account Linking / BI-SNAP menghubungkan **akun GoPay pelanggan/pembayar**. Alurnya B2B token, Get Auth Code, Binding; halaman PIN/OTP GoPay menghasilkan otorisasi pelanggan. Tidak memberikan akses dashboard/outlet merchant. Jangan gunakan produk ini untuk memperbaiki `AUTH_REJECTED` merchant. [Account Linking API](https://docs.midtrans.com/reference/account-linking-api)

## 4. Izin kontraktual dan batas klaim

Ketentuan GoBiz Developer Portal yang masih ditautkan portal, versi `v01.2022`, menyatakan integrasi hanya melalui laman aktivasi platform atau tim resmi MAM (Pasal 2), dan membatasi reverse engineering, scraping, akses tidak resmi serta eksploitasi sistem/data (Pasal 5). Ketentuan layanan tambahan juga berlaku. [Ketentuan resmi](https://app.gobiz.com/files/terms-and-condition/gobiz-developer-portal-v01.2022)

Konsekuensi praktis: persetujuan pemilik akun atau kesediaan menerima risiko **bukan** bukti persetujuan provider terhadap private login. Tidak ditemukan izin publik yang membolehkan PayGate mengambil password/OTP GoBiz melalui form sendiri. Jalur yang terdokumentasi adalah redirect dan consent provider, lalu akses outlet sesuai role/scope. Ini ringkasan kontrak, bukan pendapat hukum atau keputusan bahwa tindakan tertentu pasti merupakan tindak pidana.

## 5. Blocker dan handoff

- Untuk **OAuth + selector GoBiz**: butuh `client_id`, `client_secret`, callback terdaftar, scope discovery/payment yang disetujui, merchant berwenang, serta verifikasi/aktivasi production. Kepemilikan kredensial PayGate belum diperiksa.
- Untuk **checkout Midtrans**: butuh akun aktif, key sandbox/production dan aktivasi QRIS sesuai onboarding. Merchant ID saja tidak cukup.
- Integrasi resmi membuat transaksi/provider status. Tidak terbukti otomatis dapat membaca seluruh riwayat QR statis atau private feed GoBiz yang digunakan PayGate sebelumnya; jangan janjikan kompatibilitas tanpa verifikasi cakupan provider.
- Saran UI: tampilkan `Hubungkan GoBiz (OAuth resmi)` bila konfigurasi partner siap; jika belum, tampilkan blocker onboarding. Untuk QRIS baru, sediakan konfigurasi Midtrans. Jangan menyamarkan login privat sebagai resmi.
- Riset GoPay/Midtrans ini tidak membuktikan dukungan merchant password/OTP/selector Shopee; perlu riset kontrak Shopee terpisah.

Verifikasi: halaman resmi di atas berhasil diambil lewat web extraction atau HTTP GET HTML. Beberapa extraction timeout; fallback GET berhasil untuk auth, token-info, linking, listing, payment, dan ketentuan. Satu slug dugaan linking 404, diganti URL aktual `/link-outlet-by-id`. Tidak ada hasil kredensial/OTP/transaksi yang dibuat-buat. Hanya dokumen ini dibuat; kode aplikasi tidak diubah.
