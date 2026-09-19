import { auditAction } from "../middleware/console-audit.js";
import { Router } from "express";
import { db, dbNow } from "../db/index.js";
import { hashToken, randomApiKey } from "../lib/crypto.js";
import { isApiKeyName, cleanString } from "../lib/validate.js";

const router = Router();
router.use((req,res,next) => auditAction(req.method === 'POST' ? (req.path === '/' ? 'APIKEY_CREATE' : /^\/[^/]+\/revoke$/.test(req.path) ? 'APIKEY_REVOKE' : /^\/[^/]+\/regenerate$/.test(req.path) ? 'APIKEY_REGENERATE' : null) : null)(req,res,next));

// List API keys (tampilkan prefix + nama, tanpa hash)
router.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, prefix, last_used, created_at, revoked_at
       FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(req.user.id);
  res.json({
    keys: rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      last_used: r.last_used,
      created_at: r.created_at,
      revoked: !!r.revoked_at,
    })),
  });
});

// Create API key — generate sekali, tampilkan plaintext SEKALI aja
router.post("/", (req, res) => {
  const name = cleanString(req.body?.name || "API Key", 60);
  if (!isApiKeyName(name)) {
    return res.status(422).json({ error: "Nama API key tidak valid (max 60 char, tanpa simbol aneh)." });
  }
  const plain = randomApiKey();
  const prefix = plain.slice(0, 14) + "..."; // pgk_live_abcd...
  const keyHash = hashToken(plain);
  db.prepare("INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(req.user.id, name, keyHash, prefix, Date.now());
  res.status(201).json({ ok: true, key: plain, prefix });
});

// Revoke API key
router.post("/:id/revoke", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "ID invalid." });
  const result = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(Date.now(), id, req.user.id);
  if (result.changes === 0) return res.status(404).json({ error: "API key tidak ditemukan." });
  res.json({ ok: true });
});

// Regenerate = revoke lama + buat baru (dengan nama sama)
router.post("/:id/regenerate", (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare("SELECT id, name FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .get(id, req.user.id);
  if (!row) return res.status(404).json({ error: "API key tidak ditemukan." });

  // revoke yang lama
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), row.id);

  const plain = randomApiKey();
  const prefix = plain.slice(0, 14) + "...";
  db.prepare("INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(req.user.id, row.name, hashToken(plain), prefix, Date.now());
  res.json({ ok: true, key: plain, prefix });
});

export default router;