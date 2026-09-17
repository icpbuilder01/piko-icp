import { AuthClient } from "@icp-sdk/auth/client";

// Defaults to the current Internet Identity frontend (id.ai) already.
const MAX_TTL_NANOSECONDS = BigInt(24 * 60 * 60) * BigInt(1_000_000_000); // 24h

// Every IC canister is reachable from at least two real, distinct origins
// -- <id>.icp.net (what this project always links to -- whitepaper,
// landing, README) and <id>.icp0.io (a standard boundary-node domain,
// works identically, never advertised but real and publicly reachable).
// Internet Identity derives a *different* principal per origin by design,
// so the same II anchor produces two different principals for this same
// site depending purely on which of the two domains happened to be open
// -- confirmed as the real cause of a user-reported "my account changed"
// bug (same anchor, mobile browser had opened the icp0.io URL at some
// point, PC used the icp.net one -- two different principals for the same
// person). Fixed by always deriving *as if* the canonical icp.net origin
// were current, regardless of which real domain is actually loaded --
// requires this exact origin to serve /.well-known/ii-alternative-origins
// listing the icp0.io domain as permitted (see public/.well-known/
// ii-alternative-origins), which -- since icp0.io and icp.net serve the
// identical asset store for the same canister -- it automatically does.
// Skipped for local dev: the canonical mainnet origin isn't relevant (or
// reachable in the same sense) when testing against a local replica.
const CANONICAL_ORIGIN = "https://5xdl7-taaaa-aaaaj-qseeq-cai.icp.net";

let authClientPromise: Promise<AuthClient> | null = null;

function getAuthClient(): Promise<AuthClient> {
  if (!authClientPromise) {
    // Mining is meant to run unattended in the background (no mouse/keyboard
    // needed once started), but AuthClient's default IdleManager only watches
    // real input events and force-logs-out + reloads after 10 min of none --
    // killing the in-progress mining worker. Disabled since idle detection
    // makes no sense for this app's core use case.
    authClientPromise = Promise.resolve(
      new AuthClient({ idleOptions: { disableIdle: true } }),
    );
  }
  return authClientPromise;
}

export async function login() {
  const client = await getAuthClient();
  const isLocal = window.location.hostname.endsWith("localhost");
  return client.signIn({
    maxTimeToLive: MAX_TTL_NANOSECONDS,
    ...(isLocal ? {} : { derivationOrigin: CANONICAL_ORIGIN }),
  });
}

export async function logout() {
  const client = await getAuthClient();
  await client.signOut();
}

export async function getStoredIdentity() {
  const client = await getAuthClient();
  return client.isAuthenticated() ? client.getIdentity() : null;
}
