import { config } from "../config.js";
import { syncLabAccounts, pollLabAccount, handleLabTransaction, LAB_PROVIDERS } from "./lab.js";

export async function runLabPollCycle(userId = config.labUserId) {
  if (!config.labUnofficialEnabled || userId !== config.labUserId) return { ok: false, skipped: true };
  const results = [];
  for (const provider of LAB_PROVIDERS) results.push(await pollLabAccount(provider, userId));
  return { ok: true, results };
}

let labTimer = null;
export function startPolling() {
  if (!config.labUnofficialEnabled || labTimer) return;
  syncLabAccounts();
  console.warn(`[poll] LAB UNOFFICIAL enabled (${config.labPollIntervalMs}ms); private upstream may flag the account`);
  const tick = () => runLabPollCycle().catch(() => console.warn('[poll:lab] Cycle failed; no raw provider error logged'));
  void tick();
  labTimer = setInterval(tick, config.labPollIntervalMs);
}
export function stopPolling() {
  if (labTimer) clearInterval(labTimer);
  labTimer = null;
}
export const _test = { runLabPollCycle, handleLabTransaction };
