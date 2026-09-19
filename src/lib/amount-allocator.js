// Amount Allocator — ported from paygateme payment/allocator.go (MIT).
// Provider-agnostic: uniqueness is enforced on the FINAL amount (baseAmount+offset),
// not on the offset alone. `3500+1` and `3499+2` both settle at `3501`.

const DEFAULT_MAX_OFFSET = 999;
const MAX_OFFSET_CEILING = 999;

export function allocateUniqueAmount(baseAmount, taken, opts = {}) {
  if (!Number.isInteger(baseAmount) || baseAmount < 1) {
    const e = new Error("baseAmount harus bilangan bulat positif (IDR).");
    e.code = "INVALID_BASE";
    throw e;
  }
  if (!(taken instanceof Set)) {
    const e = new Error("taken harus instance Set dari nominal aktif.");
    e.code = "INVALID_TAKEN";
    throw e;
  }
  const maxRaw = Number.isInteger(opts.maxOffset) && opts.maxOffset >= 1 ? opts.maxOffset : DEFAULT_MAX_OFFSET;
  const max = Math.min(maxRaw, MAX_OFFSET_CEILING);
  for (let offset = 1; offset <= max; offset++) {
    const candidate = baseAmount + offset;
    if (!taken.has(candidate)) {
      return { offset, uniqueAmount: candidate };
    }
  }
  const e = new Error(`Slot nominal unik habis untuk base ${baseAmount} (offset 1..${max} semua terpakai).`);
  e.code = "AMOUNT_POOL_EXHAUSTED";
  throw e;
}

// Helper for the orders module: snapshot of amounts currently active in the
// SQLite `orders` table for a given provider account, plus amounts quarantined
// within the 2*clockSkew window after release.
export function collectTakenAmounts(db, { provider, accountId, now, clockSkewMs = 60_000 }) {
  const taken = new Set();
  const rows = db
    .prepare(
      "SELECT amount FROM orders WHERE provider=? AND account_id=? AND status IN ('pending','paid','expired') AND expires_at > ?"
    )
    .all(provider, accountId, now - 24 * 60 * 60 * 1000);
  for (const r of rows) {
    if (Number.isSafeInteger(r.amount) && r.amount > 0) taken.add(r.amount);
  }
  // Quarantine: amounts freed (status moved from pending->expired) within the last
  // 2*clockSkew window. We approximate by also including pending orders' baseAmount+offset
  // ranges within the last 2*clockSkew. For the lab use case, the explicit rows above
  // cover active + recently paid + recently expired, which is conservative.
  void clockSkewMs;
  return taken;
}
