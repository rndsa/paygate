# paygate

Self-hosted payment gateway for personal use. It generates dynamic QRIS codes, takes payments through ShopeePay and GoPay, and keeps all transaction data on your own server.

Status: **unfinished**. The ShopeePay path works end to end in my testing. The GoPay path logs in, but payment polling is unreliable. Read the code before pointing real money at it.

## What it does

- Dynamic QRIS: the amount is baked into each code, so a payment can only match its order
- Web dashboard (EJS): password + TOTP login, order list, income view
- API keys (`sk-...`) so other programs can create orders and check status
- A poller that watches for incoming payments and flips orders to paid
- Income tracking, automatic amount allocation, tax math
- Shopee login automation through a headless browser helper (`src/services/shopee_browser.py`)
- Rate limiting, security headers, and audit logging on the console endpoints

## What it doesn't do yet

- GoPay payments are not reliable end to end
- No webhooks. Your integrations have to poll.
- No Docker setup
- API docs are thin. `docs/` has research notes, not reference material.

## Running it

Node 18 or newer. A couple of test suites hit the real network, so don't be surprised by slow `npm test` runs.

```bash
git clone https://github.com/rndsa/paygate.git
cd paygate
npm install
cp .env.example .env   # fill it in yourself, see below
npm run setup          # creates the database and the admin account
npm start              # listens on localhost:3000
```

`npm run dev` restarts on file changes.

### Config

Copy `.env.example` to `.env`. Minimum:

- `COOKIE_SECRET` - generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `ADMIN_PASSWORD`

The other variables are documented inline in the example file.

### How the Shopee flow works

`src/services/shopee.js` drives your own Shopee account: it logs in through the Python helper, watches for incoming payment notifications, and matches them against open orders. Nothing here talks to a bank or PSP API. It is polling and parsing, all local.

## Layout

```
src/routes      HTTP handlers
src/services    provider logic (shopee, gopay, poller)
src/lib         qris, crypto, totp, tax, allocation
src/middleware  security headers, rate limit, console audit
views           EJS templates
tests           one file per feature, run with npm test
docs            research notes from building this
```

## License

MIT. See [LICENSE](LICENSE).
