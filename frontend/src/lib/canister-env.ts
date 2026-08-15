import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";

// The `icp` CLI sets `PUBLIC_CANISTER_ID:<name>` for every canister in the
// project on the asset canister's environment (see vite.config.ts for how
// this is mirrored during local dev via a cookie).
interface CanisterEnv {
  readonly "PUBLIC_CANISTER_ID:mother": string;
  readonly "PUBLIC_CANISTER_ID:ledger": string;
  readonly "PUBLIC_CANISTER_ID:miner": string;
  readonly "PUBLIC_CANISTER_ID:casino-frontend": string;
}

export const canisterEnv = getCanisterEnv<CanisterEnv>();

export const motherCanisterId = canisterEnv["PUBLIC_CANISTER_ID:mother"];
export const ledgerCanisterId = canisterEnv["PUBLIC_CANISTER_ID:ledger"];
// The *reference* miner instance (see README's canister table) -- the one
// this project itself deploys and keeps running, not a user's own miner.
export const referenceMinerCanisterId = canisterEnv["PUBLIC_CANISTER_ID:miner"];
export const rootKey = canisterEnv.IC_ROOT_KEY;

// PIKO Dice lives in its own canister, a deliberately separate site rather
// than another page of this one (see casino-frontend/) -- so linking to it
// means building a real cross-canister URL, not a relative path. Local
// network canisters are served at <id>.localhost:<gateway port> (see
// icp.yaml's networks.local.gateway.port); mainnet canisters at
// <id>.icp.net (see README's canister table). The current hostname is
// enough to tell the two apart: only the local gateway ever serves from a
// *.localhost host.
const LOCAL_GATEWAY_PORT = 8010;
export function canisterUrl(id: string): string {
  return window.location.hostname.endsWith("localhost")
    ? `http://${id}.localhost:${LOCAL_GATEWAY_PORT}/`
    : `https://${id}.icp.net/`;
}

export const casinoFrontendCanisterId = canisterEnv["PUBLIC_CANISTER_ID:casino-frontend"];
export const casinoFrontendUrl = canisterUrl(casinoFrontendCanisterId);
