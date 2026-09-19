# ⚡ PAYGATE

<div align="center">

<!-- Animated banner (capsule-render) -->
![PayGate Banner](https://capsule-render.vercel.app/api?type=waving&color=0:1a1a2e,50:16213e,100:0f3460&height=180&section=header&text=PAYGATE&fontSize=60&fontColor=e94560&animation=fadeIn&desc=Self-hosted%20QRIS%20Payment%20Gateway&descSize=18&descAlignY=65)

![Status](https://img.shields.io/badge/status-UNFINISHED%20🚧-orange?style=for-the-badge&logo=construction)
![Language](https://img.shields.io/badge/node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&logo=open_source_initiative)
![PRs](https://img.shields.io/badge/PRs-welcome-ff69b4?style=for-the-badge&logo=github)

*🎓 Self-hosted personal payment gateway — QRIS via ShopeePay / GoPay, hardened auth & API keys.*

</div>

---

## 🚧 STATUS: UNFINISHED / WORK IN PROGRESS

> [!WARNING]
> **Project ini BELUM SELESAI.** Repo ini adalah *source code kosongan* — semua data runtime, kredensial, database, dan config pribadi **sengaja TIDAK disertakan**.
>
> - ❌ Belum semua fitur stabil
> - ❌ Belum ada panduan produksi lengkap
> - ✅ Struktur kode, API, dan UI dasar sudah ada

---

## 🤔 Apa Ini?

**PayGate** adalah gateway pembayaran personal yang self-hosted:

| Fitur | Keterangan |
|---|---|
| 📱 **QRIS Dinamis** | Generate QRIS per-transaksi via ShopeePay / GoPay |
| 🔐 **Auth Hardened** | Password + TOTP 2FA + rate limiting + session hardened |
| 🗝️ **API Keys** | Key `sk-...` per-client untuk integrasi programatik |
| 📊 **Dashboard Web** | UI EJS (login, OTP, orders, income, pengaturan) |
| 💰 **Tracking Income** | Rekap dana masuk + alokasi amount otomatis |
| 🛡️ **Security Middleware** | Security headers, rate limit, audit console |

### 🎯 Kenapa self-hosted?

- 🏠 **Data milik lu** — gak ada pihak ketiga pegang data transaksi
- 🔓 **MIT License** — bebas modifikasi
- 🧩 **Modular** — provider baru gampang ditambahin

---

## 🛠️ Cara Jalanin

### 📋 Prasyarat

- Node.js **18+**
- (Opsional) Python 3 untuk helper browser-automation Shopee
- (Opsional) Caddy/Nginx untuk reverse proxy + TLS

### ⚡ Quick Start

```bash
# 1️⃣ Clone
git clone https://github.com/rndsa/paygate.git
cd paygate

# 2️⃣ Install deps
npm install

# 3️⃣ Setup config — salin contoh, ISI SENDIRI nilainya
cp .env.example .env

# 4️⃣ Setup awal (bikin admin & database)
npm run setup

# 5️⃣ Jalanin!
npm start          # atau: npm run dev (hot reload)
```

Server default listen di **`http://localhost:3000`** 🎉

### ⚙️ Config (`.env`)

> [!IMPORTANT]
> `.env` **tidak ikut di-commit** (lihat `.gitignore`). Isi sendiri sesuai `.env.example`:

```env
PORT=3000
SESSION_SECRET=<random-long-string>
ADMIN_PASSWORD=<password-lu>
# ... sisanya lihat .env.example
```

### 🧪 Test

```bash
npm test
```

---

## 🗺️ Roadmap

- [x] Struktur dasar + auth (password, TOTP)
- [x] Generate QRIS dinamis
- [x] Dashboard UI dasar
- [x] API key management
- [x] Income tracking + alokasi amount
- [x] ShopeePay flow (browser automation)
- [ ] 🚧 GoPay flow stabil
- [ ] 🚧 Webhook/callback untuk notifikasi pembayaran
- [ ] 🚧 Multi-provider interface
- [ ] 🚧 Docker support
- [ ] 🚧 Dokumentasi API lengkap

---

## 🗂️ Struktur Project

```
paygate/
├── 📂 src/
│   ├── 📄 server.js          # Entry point
│   ├── 📂 routes/            # HTTP routes (auth, orders, qris, ...)
│   ├── 📂 services/          # Provider logic (shopee, gopay, poller)
│   ├── 📂 lib/               # Util (qris, crypto, totp, tax, ...)
│   ├── 📂 middleware/        # Security, rate limit, audit
│   └── 📂 db/                # Database layer
├── 📂 views/                 # EJS templates (UI)
├── 📂 public/                # Static assets (CSS/JS)
├── 📂 tests/                 # Test suites
├── 📂 docs/                  # Dokumentasi riset & design
├── 📂 deploy/                # systemd, helper deploy
└── 📄 .env.example           # Contoh config
```

---

## 🔐 Keamanan

> [!CAUTION]
> Jangan pernah commit `.env`, database, atau kredensial apapun ke repo publik!

- 🔑 Password admin di-hashed (bcrypt)
- ⏱️ TOTP 2FA untuk akses sensitif
- 🚦 Rate limiting di semua endpoint auth
- 🧹 Audit logging untuk console admin

---

## 📜 License

MIT — lihat [LICENSE](LICENSE).

---

<div align="center">

![Footer](https://capsule-render.vercel.app/api?type=waving&color=0:0f3460,50:16213e,100:1a1a2e&height=120&section=footer&text=still%20under%20construction%20🚧&fontSize=20&fontColor=e94560)

*⭐ Star repo ini kalau mau follow progresnya!*

</div>
