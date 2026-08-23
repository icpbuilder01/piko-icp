import type { Identity } from "@icp-sdk/core/agent";
import { createActor as createLedgerActor } from "../bindings/ledger/ledger";
import { createActor as createBlackjackActor } from "../bindings/blackjack/blackjack";
import { blackjackCanisterId, ledgerCanisterId, rootKey } from "./canister-env";

export function getBlackjackActor(identity?: Identity) {
  return createBlackjackActor(blackjackCanisterId, {
    agentOptions: { rootKey, identity },
  });
}

export function getLedgerActor(identity?: Identity) {
  return createLedgerActor(ledgerCanisterId, {
    agentOptions: { rootKey, identity },
  });
}
