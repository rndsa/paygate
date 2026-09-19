import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { asyncRoute } from '../lib/async.js';

export const TERMS_VERSION = '2026-09-08-pw1';
export const TERMS_COOKIE_NAME = 'paygate_terms';
export const TERMS_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

function signature(value) {
  return createHmac('sha256', config.cookieSecret).update(`paygate:terms:${value}`).digest();
}

// Acknowledgement only: never use this cookie as authentication or merchant ownership proof.
export function hasTerms(req) {
  const value = req.cookies?.[TERMS_COOKIE_NAME];
  if (typeof value !== 'string' || value.length > 100) return false;
  const [version, expires, proof, extra] = value.split('.');
  if (extra !== undefined || version !== TERMS_VERSION || !/^\d{13}$/.test(expires || '') || !/^[a-f0-9]{64}$/.test(proof || '')) return false;
  const expiry = Number(expires);
  const now = Date.now();
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + TERMS_MAX_AGE_MS + 1000) return false;
  const supplied = Buffer.from(proof, 'hex');
  const expected = signature(`${version}.${expires}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function safeNext(value) {
  // ponytail: plain local URLs only; add a canonical decoding policy before allowing percent-encoded returns.
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.includes('//') || /[%\\\s\x00-\x20\x7f-\x9f]/.test(value)) return '/login';
  try {
    const url = new URL(value, 'https://paygate.invalid');
    if (url.origin !== 'https://paygate.invalid' || /^\/terms(?:\/|$)/i.test(url.pathname)) return '/login';
    return url.pathname + url.search + url.hash;
  } catch { return '/login'; }
}

function renderTerms(res, { next, error = null, declined = false, status = 200 } = {}) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).render('terms', {
    csrfToken: res.locals.csrfToken,
    next: safeNext(next), version: TERMS_VERSION, error, declined,
  });
}

export function requireTerms(req, res, next) {
  if (hasTerms(req)) return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(303, '/terms?next=' + encodeURIComponent(safeNext(req.originalUrl)));
  }
  return renderTerms(res, {
    status: 403, next: req.body?.next,
    error: 'Persetujuan belum tersedia atau sudah kedaluwarsa. Baca dan setujui ketentuan sebelum melanjutkan; login belum diproses.',
  });
}

const router = Router();
// Parent must mount its body parser, cookie parser and CSRF middleware before this router.
router.get('/license.txt', (req, res) => res.type('text/plain').sendFile(path.join(ROOT, 'LICENSE')));
router.get('/license', asyncRoute(async (req, res) => {
  const licenseText = await readFile(path.join(ROOT, 'LICENSE'), 'utf8');
  res.render('license', { licenseText });
}));
router.get('/terms/details', (req, res) => res.render('terms-detail'));
router.get('/terms', (req, res) => renderTerms(res, {
  next: req.query.next, declined: req.query.declined === '1',
}));
router.post('/terms/accept', (req, res) => {
  if (req.body?.version !== TERMS_VERSION || req.body?.accepted !== 'yes') {
    return renderTerms(res, {
      status: 422, next: req.body?.next,
      error: 'Persetujuan tidak dapat disimpan. Gunakan versi ketentuan saat ini dan centang kotak persetujuan.',
    });
  }
  const payload = `${TERMS_VERSION}.${Date.now() + TERMS_MAX_AGE_MS}`;
  res.cookie(TERMS_COOKIE_NAME, `${payload}.${signature(payload).toString('hex')}`, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd,
    maxAge: TERMS_MAX_AGE_MS, path: '/',
  });
  res.set('Cache-Control', 'no-store');
  return res.redirect(303, safeNext(req.body.next));
});

export default router;
