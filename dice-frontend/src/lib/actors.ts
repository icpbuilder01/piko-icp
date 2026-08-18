import type { Identity } from "@icp-sdk/core/agent";
import { createActor as createLedgerActor } from "../bindings/ledger/ledger";
import { createActor as createDiceActor } from "../bindings/dice/dice";
import { diceCanisterId, ledgerCanisterId, rootKey } from "./canister-env";

// We always use the root key coming back from the cookie set by the asset
// canister (or the local dev server) rather than fetching it ourselves --
// fetchRootKey() would let a man-in-the-middle substitute a fake key on
// mainnet.
export function getDiceActor(identity?: Identity) {
  return createDiceActor(diceCanisterId, {
    agentOptions: { rootKey, identity },
  });
}

export function getLedgerActor(identity?: Identity) {
  return createLedgerActor(ledgerCanisterId, {
    agentOptions: { rootKey, identity },
  });
}
