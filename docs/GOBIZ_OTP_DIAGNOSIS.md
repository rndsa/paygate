# Diagnosa GoBiz OTP — kenapa WhatsApp tidak sampai (2026-09-13)

## Ringkasan
Login merchant portal GoBiz (klien web `go-biz-web-new`) **dipaksa SMS oleh server**.
Permintaan WhatsApp diterima (HTTP 201) tapi `next_state.state` selalu `"sms"`.
Jadi kode **tidak pernah dikirim ke WhatsApp**, sekeras apa pun kita meminta.
Login lewat aplikasi resmi GoBiz memang bisa WhatsApp, tapi butuh aplikasi resmi
ter-sign (signature/attestation) — PayGate tidak bisa memalsukan itu.

## Bukti (probe terkontrol, 1 request per varian)
- `login_type: "whatsapp"` → **HTTP 201**, `next_state.state = "sms"`  ← minta WA, dikirim SMS
- tanpa `login_type` (persis portal) → **HTTP 201**, `next_state.state = "sms"`
- `login_type: "otp_whatsapp"` → **HTTP 401** `goid:error:unauthorized` ("perbarui versi aplikasi") ❌
- `login_type: "sms"` → **HTTP 201**, `next_state.state = "sms"` ✅
- Klien mobile merchant `go-biz-mobile` di `api.gobiz.co.id` → **401** (butuh app resmi)
- Klien mobile merchant di `goid.gojekapi.com` → **400** GoPay-1000 (butuh app resmi)
- Klien konsumen `gojek:consumer:app` + `otp_whatsapp` → 429 `ratelimited:device` (bukan jalur merchant)

## Kenapa OTP WA tidak sampai
1. **Server pilih SMS.** Untuk klien web ini, `next_state.state` = `"sms"` walau diminta
   `whatsapp`. Server yang menentukan kanal, bukan parameter kita. (Portal resmi pun tidak
   mengirim `login_type` sama sekali; kanal murni keputusan server.)
2. **WhatsApp cuma ada di aplikasi resmi GoBiz.** Jalur aplikasi merchant butuh
   signature/attestation aplikasi ter-sign (dibuktikan: 401 / GoPay-1000).

## Kenapa muncul "Provider menolak permintaan. Penyebab belum diketahui..."
Pesan itu **buatan kode PayGate sendiri** (`login.js`), muncul saat server balas
status di luar 401/403 saat **verifikasi OTP**. Percobaan user 10:24:
`stage=otp_verify, provider_status=400, classification=REQUEST_REJECTED`.
Artinya permintaan OTP **berhasil**; yang gagal adalah **kode yang dimasukkan** —
server bilang kode tidak diterima (salah/kedaluwarsa). Bukan kanal, bukan nomor.

## Perbaikan yang diterapkan (2026-09-13, asset `studio4j`)
1. **Pesan OTP salah kini jelas** (`OTP_INVALID`): 400 saat verifikasi → "Kode OTP tidak
   diterima. Kemungkinan salah ketik atau kedaluwarsa. Minta kode baru..." (bukan lagi
   "Provider menolak permintaan").
2. **Default kanal = SMS**, dengan hint jujur bahwa portal mengirim SMS walau diminta WA.
3. **UI menampilkan kanal yang benar-benar dipilih server** di langkah OTP
   (`gpOtpChannelInfo`, dari `next_state.state`), jadi user tahu kode dikirim lewat apa.
4. `next_state.state` sekarang disimpan utuh (bisa `"sms,whatsapp"`), tidak dipaksa satu nilai.

## Langkah user sekarang
- Buka **Akun Pembayaran → Hubungkan GoPay**, kanal **SMS** (default).
- Kirim OTP, **masukkan kode dari SMS dengan cepat** (masa berlaku pendek).
- Kalau kode error, minta kode baru dan input ulang — jangan nunggu lama.
- WhatsApp tidak bisa dipakai lewat jalur web ini (keterbatasan server, bukan bug PayGate).
