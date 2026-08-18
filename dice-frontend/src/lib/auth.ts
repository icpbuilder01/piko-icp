import { AuthClient } from "@icp-sdk/auth/client";

// Defaults to the current Internet Identity frontend (id.ai) already.
const MAX_TTL_NANOSECONDS = BigInt(8 * 60 * 60) * BigInt(1_000_000_000); // 8h

let authClientPromise: Promise<AuthClient> | null = null;

function getAuthClient(): Promise<AuthClient> {
  if (!authClientPromise) {
    authClientPromise = Promise.resolve(new AuthClient());
  }
  return authClientPromise;
}

export async function login() {
  const client = await getAuthClient();
  return client.signIn({ maxTimeToLive: MAX_TTL_NANOSECONDS });
}

export async function logout() {
  const client = await getAuthClient();
  await client.signOut();
}

export async function getStoredIdentity() {
  const client = await getAuthClient();
  return client.isAuthenticated() ? client.getIdentity() : null;
}
