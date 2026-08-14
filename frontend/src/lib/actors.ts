import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { createActor as createMotherActor } from "../bindings/mother/mother";
import { createActor as createLedgerActor } from "../bindings/ledger/ledger";
import { createActor as createIcpLedgerActor } from "../bindings/icp_ledger/icp_ledger";
import { createActor as createCmcActor } from "../bindings/cmc/cmc";
import { createActor as createManagementActor } from "../bindings/management/management";
import { createActor as createMinerActor } from "../bindings/miner/miner";
import { motherCanisterId, ledgerCanisterId, rootKey } from "./canister-env";

// The real, mainnet ICP ledger -- not a canister this project deploys, so
// it's a fixed id rather than something read from canister-env. icp-cli's
// local network mirrors this same principal (verified live), so this works
// against both local and mainnet.
export const ICP_LEDGER_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";

// The real Cycles Minting Canister -- same mirroring story as the ICP
// ledger above. Used by DeployMiner.tsx to pay for a new miner canister in
// ICP directly (notify_create_canister).
export const CMC_CANISTER_ID = "rkp4c-7iaaa-aaaaa-aaaca-cai";

// The IC management canister -- a protocol-level pseudo-canister present on
// every subnet at this fixed id, not something deployed. Used to install
// the miner wasm onto a freshly created canister.
export const MANAGEMENT_CANISTER_ID = "aaaaa-aa";

// We always use the root key coming back from the cookie set by the asset
// canister (or the local dev server) rather than fetching it ourselves --
// fetchRootKey() would let a man-in-the-middle substitute a fake key on
// mainnet.
export function getMotherActor(identity?: Identity) {
  return createMotherActor(motherCanisterId, {
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

export function getCmcActor(identity?: Identity) {
  return createCmcActor(CMC_CANISTER_ID, {
    agentOptions: { rootKey, identity },
  });
}

// The management canister isn't routable by its own principal (aaaaa-aa
// exists on every subnet, it's not a "real" canister with one home) -- a
// call to it must carry the effective canister id of whatever canister the
// call actually targets, or boundary nodes have nothing to route on.
export function getManagementActorFor(targetCanisterId: string, identity?: Identity) {
  return createManagementActor(MANAGEMENT_CANISTER_ID, {
    agentOptions: { rootKey, identity },
    actorOptions: {
      canisterId: MANAGEMENT_CANISTER_ID,
      effectiveCanisterId: Principal.fromText(targetCanisterId),
    },
  });
}

// Deploying a miner canister needs its own actor pointed at whatever
// principal notify_create_canister just minted -- not known until runtime,
// so this takes the id directly rather than reading it from canister-env.
export function getMinerActorAt(canisterId: string, identity?: Identity) {
  return createMinerActor(canisterId, {
    agentOptions: { rootKey, identity },
  });
}
