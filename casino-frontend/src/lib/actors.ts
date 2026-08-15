import type { Identity } from "@icp-sdk/core/agent";
import { createActor as createLedgerActor } from "../bindings/ledger/ledger";
import { createActor as createIcpLedgerActor } from "../bindings/icp_ledger/icp_ledger";
import { createActor as createCasinoActor } from "../bindings/casino/casino";
import { casinoCanisterId, ledgerCanisterId, rootKey } from "./canister-env";

// The real, mainnet ICP ledger -- not a canister this project deploys, so
// it's a fixed id rather than something read from canister-env. icp-cli's
// local network mirrors this same principal (verified live), so this works
// against both local and mainnet.
export const ICP_LEDGER_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";

// We always use the root key coming back from the cookie set by the asset
// canister (or the local dev server) rather than fetching it ourselves --
// fetchRootKey() would let a man-in-the-middle substitute a fake key on
// mainnet.
export function getCasinoActor(identity?: Identity) {
  return createCasinoActor(casinoCanisterId, {
    agentOptions: { rootKey, identity },
  });
}

export function getLedgerActor(identity?: Identity) {
  return createLedgerActor(ledgerCanisterId, {
    agentOptions: { rootKey, identity },
  });
}

export function getIcpLedgerActor(identity?: Identity) {
  return createIcpLedgerActor(ICP_LEDGER_CANISTER_ID, {
    agentOptions: { rootKey, identity },
  });
}
