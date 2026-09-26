# paygate

[![Node.js](https://img.shields.io/badge/node-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Worker](https://img.shields.io/badge/worker-Playwright_Chromium-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev)
[![Database](https://img.shields.io/badge/database-SQLite3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org)
[![Standard](https://img.shields.io/badge/standard-EMVCo_QRIS_2.0-orange?style=flat-square)](https://www.qris.id)
[![Architecture](https://img.shields.io/badge/architecture-Local_First-6B46C1?style=flat-square)](#architecture)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

Self-hosted personal payment gateway and dynamic QRIS orchestrator. Runs on your own Linux hardware, bridges payments directly through personal ShopeePay and GoPay merchant sessions, and stores all transaction records in a local SQLite database without third-party aggregator middleman fees, legal entity locks (PT/CV), or external API dependencies.

---

## 🎯 Untuk Apa Project Ini Berjalan?

Payment gateway komersial konvensional (seperti Midtrans, Xendit, Tripay, atau Duitku) memiliki hambatan signifikan bagi pengembang independen, proyek micro-SaaS, dan pelaku usaha personal:
* **Persyaratan Legalitas & KYC Ketat**: Mewajibkan entitas badan usaha resmi (PT/CV), verifikasi rekening bisnis perusahaan, dan verifikasi dokumen yang memakan waktu berhari-hari.
* **Potongan Biaya Transaksi (MDR Fee)**: Biaya potongan sebesar 0.7% s.d. 1.5% + PPN per transaksi yang memotong margin keuntungan layanan mikro.
* **Siklus Settlement Bertingkat (Holding Dana)**: Dana transaksi ditahan selama T+1 hingga T+3 hari kerja sebelum bisa ditarik ke rekening utama, serta dikenakan biaya transfer antar bank.

**PayGate** dibangun dengan filosofi **Local-First & Direct-to-Merchant**:
1. **Bypass Biaya Aggregator Pihak Ketiga**: Pembayaran via QRIS langsung masuk 100% secara real-time ke saldo merchant ShopeePay / GoPay Anda sendiri tanpa potongan komisi per transaksi.
2. **Dynamic QRIS Generator (EMVCo 2.0)**: Mengubah QRIS statis merchant personal menjadi kode QR dinamis dengan nominal otomatis menggunakan format EMVCo Tag 54, mencegah salah transfer atau salah input nominal oleh pembeli.
3. **Penyimpanan Lokal (Zero External Database)**: Semua rekonsiliasi data transaksi, log order, dan kunci API tersimpan aman di SQLite lokal server tanpa ketergantungan DB cloud eksternal.
4. **Otomasi Ledger via Headless Browser**: Menggunakan Playwright Chromium terisolasi di background untuk membaca mutasi saldo secara instan dan memicu webhook konfirmasi pembayaran dalam hitungan detik.

---

## ⚖️ Kelebihan & Kekurangan

| Kategori | Kelebihan (Pros) | Kekurangan (Cons) |
|---|---|---|
| **Finansial & Biaya** | **0% MDR Fee Aggregator**: Transaksi masuk utuh 100% ke saldo merchant Anda tanpa potongan fee pihak ketiga. Dana langsung cair seketika (*instant settlement*). | **Bukan PSP Berlisensi**: Beroperasi menggunakan otomasi portal merchant mandiri, bukan API formal perbankan / Payment Service Provider terlisensi Bank Indonesia. |
| **Persyaratan Akun** | **Tanpa Badan Hukum PT/CV**: Cukup menggunakan akun merchant personal ShopeePay atau GoBiz yang telah aktif dan terverifikasi standar. | **Manajemen Sesi Merchant**: Sesi login browser merchant membutuhkan pembaruan berkala jika session cookie kedaluwarsa atau diminta OTP relogin. |
| **Privasi & Arsitektur** | **100% Self-Hosted & Local-First**: Semua data transaksi, kunci enkripsi, dan rekonsiliasi tersimpan di server Anda sendiri via SQLite3 terenkripsi. | **Kebutuhan Resource Server**: Menjalankan engine headless Chromium (Playwright) membutuhkan alokasi RAM minimal 512MB–1GB pada VPS. |
| **Integrasi Klien** | **Universal REST API & Webhook**: Menyediakan REST API sederhana untuk pembuatan tagihan QRIS serta webhook callback otomatis ke aplikasi storefront Anda. | **Tergantung Struktur UI Merchant**: Jika pihak Shopee/GoPay merombak total struktur HTML dashboard merchant mereka, skrip selektor scraping perlu disesuaikan. |

---

## Status & Provider Support

| Provider | Merchant Authentication | Payment Detection | Real-time Settlement | Maturity |
|---|---|---|---|---|
| **ShopeePay** | Headless Browser (Playwright) | Polling Merchant Ledger | Verified 1:1 Matching | Production-tested |
| **GoPay / GoBiz** | Native HTTP Session + OTP | Transaction Feed Polling | Experimental | Requires manual audit |

> **Notice**: Built for personal automation and micro-services. Integrates against merchant portals via reverse-engineered automation, not licensed PSP/bank APIs. Test with small amounts before pointing commercial volume at it.

---

## Architecture

```
                       ┌──────────────────────────────┐
                       │   Client / Storefront App   │
                       └──────────────┬───────────────┘
                                      │ HTTP REST API (X-Api-Key)
                                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PayGate Server (:3000)                                                 │
│                                                                        │
│  ├─ API Routing     : Express.js (orders, accounts, settings, keys)   │
│  ├─ Auth & Security : TOTP 2FA, signed HttpOnly cookies, CSRF, rate-lim│
│  ├─ Core Engines    : Dynamic QRIS (EMVCo), local accounting ledger    │
│  ├─ Storage Layer   : SQLite local database                            │
│  └─ Background Poller: Reconciliation matching amount + time window    │
└───────────────┬────────────────────────────────────────┬───────────────┘
                │ IPC Subprocess                         │ Direct HTTP
                ▼                                        ▼
┌──────────────────────────────┐        ┌────────────────────────────────┐
│ Playwright Worker            │        │ GoBiz Gateway Client           │
│ (src/services/shopee_browser)│        │ (Session & Token Management)   │
└───────────────┬──────────────┘        └────────────────────────────────┘
                │ Headless Chromium
                ▼
┌──────────────────────────────┐
│ Shopee Merchant Portal       │
└──────────────────────────────┘
```

---

## Core Systems

### 1. Dynamic QRIS Generation (EMVCo)
Standard static QRIS codes require the customer to type the payment amount manually, leading to underpayments, overpayments, or misattributed orders. PayGate parses your static merchant QR string and dynamically injects:
- **Tag 54** (Transaction Amount): Exact order total in IDR.
- **Tag 01** (Point of Initiation Method): Set to `12` (Dynamic).
- **Tag 58** (Country Code) & **Tag 53** (Currency Code): `ID` / `360`.
- **Tag 63** (CRC16-CCITT): Recomputed checksum validating the entire payload.

### 2. Zero-Discrepancy Reconciliation Engine
Matches incoming transaction notifications against pending database orders:
- **Exact Amount Matching**: No tolerance window for amount discrepancies.
- **Timestamp Filtering**: Scans settlement events strictly occurring between `order.created_at` and `order.expires_at`.
- **Duplicate Protection**: Prevents duplicate claims by locking order records during state transitions.

### 3. Headless Merchant Session Automation
Because Shopee Merchant has no public open developer API, `src/services/shopee_browser.py` runs an isolated Chromium process to:
- Authenticate merchant credentials and handle OTP challenges.
- Refresh session cookies and security tokens automatically.
- Read real-time incoming balance updates and transaction history directly from the portal.

### 4. Hardened Security
- **TOTP Two-Factor Authentication**: Enforced for admin dashboard access alongside strong bcrypt password hashing.
- **Strict CSRF & Cookies**: Signed `HttpOnly`, `SameSite=Lax` session cookies with per-session CSRF tokens.
- **Audit Logging**: Comprehensive logging of console commands, API key actions, and authentication attempts.
- **Scoped API Keys**: Stateless `sk-...` keys for external applications with granular rate-limiting.

---

## Prerequisites

- **Node.js**: `18.x` or newer
- **Python**: `3.10+` with Playwright installed
- **Operating System**: Linux (Ubuntu 22.04/24.04 or Debian 12 recommended)
- **Database**: SQLite3 (bundled via `better-sqlite3` / `sqlite3`)

---

## Getting Started

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/rndsa/paygate.git
cd paygate

# Install Node.js packages
npm install

# Setup Python Playwright environment
pip install playwright
playwright install chromium --with-deps
```

### 2. Environment Configuration

Copy the template:

```bash
cp .env.example .env
```

Generate a cryptographic secret for cookie signing:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Configure `.env`:

```ini
PORT=3000
NODE_ENV=production
COOKIE_SECRET=your_32_byte_random_hex_secret
ADMIN_PASSWORD=your_strong_admin_password
LAB_USER_ID=admin
POLL_INTERVAL_MS=60000
```

### 3. Database Initialization

Bootstrap the SQLite database and create the initial admin user:

```bash
npm run setup
```

### 4. Running the Server

```bash
# Production mode
npm start

# Development mode (auto-reload on code change)
npm run dev
```

The web console will be available at `http://localhost:3000`.

---

## Production Deployment (systemd + Nginx)

### systemd Service

Copy the bundled unit file and start the daemon:

```bash
sudo cp deploy/paygate.service /etc/systemd/system/paygate.service
sudo systemctl daemon-reload
sudo systemctl enable --now paygate
```

Inspect service health:

```bash
sudo systemctl status paygate
journalctl -u paygate -f
```

### Nginx Reverse Proxy Configuration

```nginx
server {
    listen 80;
    server_name pay.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## API Reference

External services interact with PayGate using HTTP requests authenticated with `X-Api-Key`.

### Create Order

```bash
curl -X POST http://localhost:3000/api/orders/create \
  -H "X-Api-Key: sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "shopeepay",
    "amount": 25000,
    "description": "Subscription Plan A"
  }'
```

**Response (201 Created):**

```json
{
  "ok": true,
  "order_id": "ORD-20260924-A19F",
  "provider": "shopeepay",
  "amount": 25000,
  "status": "pending",
  "qris_string": "00020101021226...",
  "expires_at": "2026-09-24T23:45:00.000Z"
}
```

### Check Order Status

```bash
curl -X GET http://localhost:3000/api/orders/ORD-20260924-A19F/status \
  -H "X-Api-Key: sk-your-api-key"
```

**Response (200 OK):**

```json
{
  "order_id": "ORD-20260924-A19F",
  "amount": 25000,
  "status": "paid",
  "paid_at": "2026-09-24T23:32:15.000Z",
  "provider": "shopeepay"
}
```

For complete endpoint contracts, webhooks, and account management parameters, see [docs/API.md](docs/API.md).

---

## Test Suite

PayGate includes both unit integration tests and full headless browser regression tests:

```bash
# Run unit & API integration tests
npm test

# Run Playwright real-browser UI regression suite
python3 tests/ui_smoke.py
```

---

## Project Structure

```
paygate/
├── deploy/            # systemd service unit, deployment automation
├── docs/              # Protocol specifications & merchant connection guides
│   ├── API.md         # Comprehensive REST API reference
│   ├── SHOPEE_CONNECT.md # Step-by-step Shopee merchant portal setup
│   └── WEBSITE.md     # Storefront integration guide
├── public/            # Static assets (stylesheets, client scripts, icons)
├── src/
│   ├── db/            # SQLite schema, queries, and migration routines
│   ├── lib/           # EMVCo QRIS builder, crypto, TOTP, tax math
│   ├── middleware/    # Security headers, rate limiting, audit logger
│   ├── routes/        # Express route controllers
│   ├── services/      # ShopeePay Playwright worker, poller, account drivers
│   ├── config.js      # Environment configuration validator
│   ├── server.js      # Main HTTP server entrypoint
│   └── setup.js       # First-run database initialization & admin setup
├── tests/             # Automated test suite (npm test + ui_smoke.py)
└── views/             # Server-rendered EJS dashboard templates
```

---

## License

[MIT](LICENSE) © ren
