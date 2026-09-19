import { Router } from 'express';
import { listEvents, getEvent, requireConsoleAdmin } from '../services/console-log.js';

// Mount at /api/console after cookie/session middleware, before broad requireAuth
// if the parent wants these consistent {error,code} responses for signed-out users.
const router = Router();
router.use(requireConsoleAdmin);
const queryKeys = new Set(['level','module','since','q','before','limit']);
const invalid = () => Object.assign(new Error('Filter Console tidak valid.'), {code:'INVALID_QUERY', status:422});

function readQuery(req, detail = false) {
  // Inspect the raw query too: Express/qs can silently discard __proto__, merge
  // duplicate fields or truncate parameter counts. None should become a valid read.
  const raw = (req.originalUrl || req.url).split('?').slice(1).join('?');
  if (raw.length > 2048 || /%(?![0-9a-f]{2})/i.test(raw)) throw invalid();
  const result = Object.create(null);
  for (const [key, value] of new URLSearchParams(raw)) {
    if (detail || !queryKeys.has(key) || Object.hasOwn(result,key)) throw invalid();
    result[key] = value;
  }
  for (const key of Reflect.ownKeys(req.query || {})) {
    if (detail || !queryKeys.has(key) || typeof req.query[key] !== 'string') throw invalid();
  }
  return result;
}
function fail(res, error) {
  if (error?.code === 'INVALID_QUERY' && error.status === 422) {
    return res.status(422).json({error:'Filter Console tidak valid. Periksa level, modul, ID, waktu, dan batas halaman.', code:'INVALID_QUERY'});
  }
  return res.status(503).json({error:'Riwayat Console sementara tidak tersedia. Coba lagi nanti.', code:'CONSOLE_UNAVAILABLE'});
}
router.get('/logs', (req,res) => {
  try { res.json(listEvents(req.user.id, readQuery(req))); }
  catch (error) { fail(res,error); }
});
router.get('/logs/:id', (req,res) => {
  try {
    readQuery(req, true);
    if (!/^[1-9][0-9]*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) throw invalid();
    const entry = getEvent(req.user.id, Number(req.params.id));
    if (!entry) return res.status(404).json({error:'Entri Console tidak ditemukan.', code:'NOT_FOUND'});
    res.json({entry});
  } catch (error) { fail(res,error); }
});
// No arbitrary event ingestion, deletion, command execution or filesystem APIs.
router.use((req,res) => res.status(404).json({error:'Endpoint Console tidak ditemukan.',code:'NOT_FOUND'}));
// Express decodes route params before invoking the handler. Keep malformed UTF-8
// and percent escapes out of its HTML/stack-bearing default error response.
router.use((error,req,res,next) => {
  res.set('Cache-Control','no-store');
  fail(res, error instanceof URIError ? invalid() : error);
});
export default router;
