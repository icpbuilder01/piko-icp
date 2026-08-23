import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";

interface CanisterEnv {
  readonly "PUBLIC_CANISTER_ID:blackjack": string;
  readonly "PUBLIC_CANISTER_ID:test-ledger": string;
}

export const canisterEnv = getCanisterEnv<CanisterEnv>();

export const blackjackCanisterId = canisterEnv["PUBLIC_CANISTER_ID:blackjack"];
export const rootKey = canisterEnv.IC_ROOT_KEY;

// Only the local gateway serves from a *.localhost host, so that's enough
// to tell local dev apart from mainnet.
const isLocal = window.location.hostname.endsWith("localhost");

// The real, live PIKO ledger on mainnet -- blackjack itself defaults to this
// same id (see blackjack/src/main.mo's ledger wiring) and only ever gets
// redirected to a local test-ledger for local development.
const REAL_PIKO_LEDGER_CANISTER_ID = "56aad-fiaaa-aaaaj-qsefa-cai";
export const ledgerCanisterId = isLocal
  ? canisterEnv["PUBLIC_CANISTER_ID:test-ledger"]
  : REAL_PIKO_LEDGER_CANISTER_ID;
