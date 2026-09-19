#!/usr/bin/env node
/**
 * PayGate Setup — interaktif.
 * Bikin user admin pertama + .env (kalau belum ada).
 * Jalankan: npm run setup
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { config, ROOT, DATA_DIR } from "./config.js";
import { db } from "./db/index.js";
import { hashPassword } from "./lib/crypto.js";
import { isUsername, isPassword, isAmount } from "./lib/validate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(ROOT, ".env");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(question, def = "") {
  const suffix = def ? ` [${def}]` : "";
  const ans = await rl.question(`${question}${suffix}: `);
  return ans.trim() || def;
}

function writeEnv(obj) {
  const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
}

console.log(`
╔══════════════════════════════════════════════╗
║            PayGate — Interactive Setup        ║
║        Self-hosted personal payment gateway    ║
╚══════════════════════════════════════════════╝
`);

// Pastikan folder data
fs.mkdirSync(DATA_DIR, { recursive: true });

// Cek user admin sudah ada?
const existingUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c;

try {
  // 1. Buat user admin pertama (kalau belum ada)
  if (existingUsers === 0) {
    console.log("\n📝 Buat akun admin pertama:");
    let username = await ask("Username", "admin");
    while (!isUsername(username)) {
      console.log("  ❌ Username 3-32 char (huruf/angka/._-)");
      username = await ask("Username", "admin");
    }

    let password = await ask("Password (min 8 char)");
    while (!isPassword(password)) {
      console.log("  ❌ Password minimal 8 karakter");
      password = await ask("Password (min 8 char)");
    }
    const confirm = await ask("Ulangi password");
    if (confirm !== password) {
      console.log("❌ Password tidak cocok. Ulangi setup.");
      process.exit(1);
    }

    const hash = await hashPassword(password);
    const now = Date.now();
    db.prepare("INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)")
      .run(username, hash, now, now);
    console.log(`  ✅ Admin "${username}" dibuat.`);
  } else {
    console.log("\nℹ️  User admin sudah ada — skip pembuatan user.");
  }

  // 2. Cek .env — kalau belum ada, bikin dari pertanyaan
  if (!fs.existsSync(envPath)) {
    console.log("\n⚙️  Konfigurasi server (disimpan ke .env):");
    const port = await ask("Port", String(config.port));
    const host = await ask("Bind host (127.0.0.1 aman; 0.0.0.0 buat akses luar)", config.host);
    const envVars = {
      NODE_ENV: "production",
      HOST: host || "127.0.0.1",
      PORT: port || "3000",
      COOKIE_SECRET: (await import("./lib/crypto.js")).randomToken(32),
      BASE_URL: await ask("BASE_URL (domain, opsional, kosongkan)", ""),
    };
    writeEnv(envVars);
    console.log("  ✅ .env dibuat.");
    console.log("\nAkun pembayaran belum terhubung; order nonaktif sampai akun live tervalidasi.");
  } else {
    console.log("\nℹ️  .env sudah ada — dibiarkan.");
  }

  console.log(`
✅ Setup selesai!
▶ Jalankan server:  npm start
▶ Buka:             http://${config.host}:${config.port}
`);
} finally {
  rl.close();
  try { db.close(); } catch {}
}
