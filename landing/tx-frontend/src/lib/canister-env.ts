import { getCanisterEnv } from "@icp-sdk/core/agent/canister-env";

// The `icp` CLI sets `PUBLIC_CANISTER_ID:<name>` for every canister in the
// project on the asset canister's environment (see vite.config.ts for how
// this is mirrored during local dev via a cookie) -- `landing` gets these
// the same way `dice-frontend`/`blackjack-frontend` do, even though it's
// deployed as a plain static-site canister with no build step of its own
// (see ../../canister.yaml): this page's built output is copied into
// ../../public/tx/ and served as part of the same `landing` canister.
interface CanisterEnv {
  readonly "PUBLIC_CANISTER_ID:index": string;
}

export const canisterEnv = getCanisterEnv<CanisterEnv>();

export const indexCanisterId = canisterEnv["PUBLIC_CANISTER_ID:index"];
export const rootKey = canisterEnv.IC_ROOT_KEY;
