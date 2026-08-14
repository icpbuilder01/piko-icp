// Tracks canister ids of miners this browser has deployed (or been told
// about), purely client-side (localStorage) -- there is no on-chain
// registry of "miners principal X controls" to query instead. Reported
// bug this exists to fix: a partial deploy failure left a real, paid-for
// miner canister with no way to find it again except parsing a sentence of
// error text. Best-effort only: a different browser/device won't see a
// miner tracked here, and clearing site data loses the list -- the
// canister itself is never at risk either way, this is purely a
// "remember where I put it" convenience.
const STORAGE_KEY = "piko.trackedMiners";

export function getTrackedMiners(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function trackMiner(canisterId: string): void {
  try {
    const existing = getTrackedMiners();
    if (existing.includes(canisterId)) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...existing, canisterId]));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) -- the miner
    // still exists and still works, it just won't be remembered here
  }
}

export function untrackMiner(canisterId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getTrackedMiners().filter((id) => id !== canisterId)));
  } catch {
    // see trackMiner
  }
}
