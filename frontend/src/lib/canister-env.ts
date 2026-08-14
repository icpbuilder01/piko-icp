import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";

// The `icp` CLI sets `PUBLIC_CANISTER_ID:<name>` for every canister in the
// project on the asset canister's environment (see vite.config.ts for how
// this is mirrored during local dev via a cookie).
interface CanisterEnv {
  readonly "PUBLIC_CANISTER_ID:mother": string;
  readonly "PUBLIC_CANISTER_ID:ledger": string;
}

export const canisterEnv = getCanisterEnv<CanisterEnv>();

export const motherCanisterId = canisterEnv["PUBLIC_CANISTER_ID:mother"];
export const ledgerCanisterId = canisterEnv["PUBLIC_CANISTER_ID:ledger"];
export const rootKey = canisterEnv.IC_ROOT_KEY;
