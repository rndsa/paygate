# paygate

Self-hosted personal payment gateway and dynamic QRIS orchestrator. Runs on your own Linux server, takes payments through ShopeePay and GoPay merchant sessions, and stores all transaction records locally in SQLite without relying on third-party payment aggregators.

Status: **in development / live-only experimental**. ShopeePay flow is tested and functional end-to-end. GoPay merchant authentication succeeds, but transaction feed polling remains experimental. Review the source before handling real transactions.

---

## Architecture

```
                       ┌──────────────────────────────┐
                       │   Client / Storefront App   │
                       └──────────────┬───────────────┘
                                      │ POST /api/orders/create (X-Api-Key)
                                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│ PayGate Server (Node.js 18+ / Express)                                 │
│                                                                        │
│  ├─ Auth & Security : TOTP 2FA, signed HttpOnly cookies, CSRF, rate-lim │
│  ├─ Core Engines    : Dynamic QRIS generator (EMVCo), local ledger     │
│  ├─ Storage Layer   : SQLite local database                            │
│  └─ Background Poller: Reconciliation matching amount + time window    │
└───────────────┬────────────────────────────────────────┬───────────────┘
                │ IPC / Subprocess                       │ HTTP API
                ▼                                        ▼
┌──────────────────────────────┐        ┌────────────────────────────────┐
│ Playwright Python Worker     │        │ GoPay Merchant Gateway         │
│ (src/services/shopee_browser)│        │ (Session / OTP verification)   │
└───────────────┬──────────────┘        └────────────────────────────────┘
                │ Headless Browser
                ▼
┌──────────────────────────────┐
│ Shopee Merchant Portal       │
└──────────────────────────────┘
```

---

## Features

- **Dynamic QRIS (EMVCo)**: Injects exact order amounts directly into the QR payload to eliminate manual transfer errors and guarantee 1:1 order reconciliation.
- **Self-Hosted Ledger**: Keeps customer identifiers, order states, fee structures, and settlement history in a private local SQLite database.
- **Merchant Session Automation**: Uses a headless Playwright runner (`src/services/shopee_browser.py`) to handle merchant portal authentication, OTP challenges, and session renewals.
- **Stateless API Keys**: External services create orders and poll statuses using scoped `sk-...` bearer keys without dashboard access.
- **Admin Dashboard**: EJS-based management console protected by password, TOTP two-factor authentication, and strict CSRF tokens.
- **Hardened Security**: Includes strict rate-limiting, timing-safe credential comparisons, audit logging, and restrictive HTTP security headers.
- **Financial Math**: Built-in tax calculations, net revenue breakdown, and multi-wallet percentage allocation rules.

---

## Prerequisites

- **Node.js**: `18.x` or newer
- **Python**: `3.10+` with Playwright (`pip install playwright && playwright install chromium`)
- **Operating System**: Linux (Ubuntu/Debian recommended)

---

## Getting Started

### 1. Installation

```bash
git clone https://github.com/rndsa/paygate.git
cd paygate
npm install
```

Install browser dependencies for the ShopeePay runner:

```bash
pip install -r requirements.txt # or: pip install playwright
playwright install chromium --with-deps
```

### 2. Configuration

Create your environment configuration from the template:

```bash
cp .env.example .env
```

Generate secure secrets for the application:

```bash
# Generate COOKIE_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Configure `.env` with your values:

```ini
PORT=3000
NODE_ENV=production
COOKIE_SECRET=your_generated_random_hex_secret
ADMIN_PASSWORD=your_secure_admin_password
LAB_USER_ID=admin
POLL_INTERVAL_MS=60000
```

### 3. Database Initialization & Admin Setup

Run the setup script to initialize the SQLite database schema and register the primary admin:

```bash
npm run setup
```

### 4. Running the Service

```bash
# Production start
npm start

# Development mode with nodemon auto-reload
npm run dev
```

The admin dashboard will be available at `http://localhost:3000`.

---

## Production Deployment (systemd)

A preconfigured service unit is provided in `deploy/paygate.service`:

```bash
sudo cp deploy/paygate.service /etc/systemd/system/paygate.service
sudo systemctl daemon-reload
sudo systemctl enable --now paygate
```

Check service status and logs:

```bash
sudo systemctl status paygate
journalctl -u paygate -f
```

---

## API Overview

External integrations interact with PayGate through standard JSON endpoints using the `X-Api-Key` header:

```bash
# Create a new dynamic QRIS order
curl -X POST http://localhost:3000/api/orders/create \
  -H "X-Api-Key: sk-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "shopeepay",
    "amount": 25000,
    "description": "Invoice #1042"
  }'
```

```bash
# Check order payment status
curl http://localhost:3000/api/orders/ORD-12345/status \
  -H "X-Api-Key: sk-your-api-key"
```

For complete endpoint contracts, error codes, and merchant connection parameters, see [docs/API.md](docs/API.md).

---

## Project Structure

```
paygate/
├── deploy/            # systemd service unit and deployment scripts
├── docs/              # Protocol specifications, API contract, and research logs
│   ├── API.md         # Full REST API documentation
│   ├── SHOPEE_CONNECT.md # Shopee merchant portal setup guide
│   └── WEBSITE.md     # Storefront integration notes
├── public/            # Static assets (CSS, client scripts, icons)
├── src/
│   ├── db/            # Database schema, migration, and connection helpers
│   ├── lib/           # EMVCo QRIS encoder, cryptographic routines, TOTP
│   ├── middleware/    # Rate limiters, security headers, console audit
│   ├── routes/        # Express route controllers (orders, accounts, dashboard)
│   ├── services/      # ShopeePay Playwright worker, poller, account drivers
│   ├── config.js      # Central environment configuration loader
│   ├── server.js      # Express server entry point
│   └── setup.js       # First-run schema setup & admin bootstrap
├── tests/             # Automated test suite (npm test)
└── views/             # EJS server-rendered templates for the admin dashboard
```

---

## License

[MIT](LICENSE) © ren (`rndsa`)
