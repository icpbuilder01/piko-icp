import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import {
  getIcpLedgerActor,
  getCmcActor,
  getManagementActorFor,
  getMinerActorAt,
  CMC_CANISTER_ID,
} from "./actors";
import { motherCanisterId } from "./canister-env";

// Mirrors mother/src/main.mo's principalToSubaccount(): the CMC identifies
// who a payment is "for" (the future controller of the canister-to-be) by a
// subaccount encoding that principal's raw bytes -- byte 0 is the length,
// bytes 1..len are the principal itself, the rest zero-padded to 32 bytes.
// Same algorithm as mother's, just ported to TS since this side of the flow
// runs in the browser instead of a canister.
function principalToSubaccount(principal: Principal): Uint8Array {
  const bytes = principal.toUint8Array();
  const subaccount = new Uint8Array(32);
  subaccount[0] = bytes.length;
  subaccount.set(bytes, 1);
  return subaccount;
}

// The CMC accepts ICP payments for several different operations (top up an
// existing canister, mint cycles, create a canister) all paid into the same
// kind of per-purpose subaccount -- this memo is what tells it which one
// this payment is for. Verified live against a local network: omitting it
// (or using the wrong one) gets the ICP refunded rather than lost, but the
// canister never gets created. Fixed protocol constant, not something to
// guess at differently elsewhere -- see MEMO_CREATE_CANISTER in
// https://github.com/dfinity/ic/blob/master/rs/nns/cmc/src/lib.rs.
const MEMO_CREATE_CANISTER = Uint8Array.from([0x43, 0x52, 0x45, 0x41, 0, 0, 0, 0]); // "CREA", u64 LE

// Candid errors routinely carry bigint fields (balances, block indices);
// plain JSON.stringify throws on those, which would otherwise replace a
// meaningful error ("insufficient funds") with a confusing unrelated one
// ("Do not know how to serialize a BigInt") -- found by hitting this for
// real while testing this flow against a local network.
function describeError(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

export type DeployStep =
  | "paying"
  | "creating"
  | "installing"
  | "funding"
  | "approving"
  | "starting"
  | "done";

export interface DeployProgress {
  step: DeployStep;
  message: string;
}

export interface DeployResult {
  canisterId: string;
}

// Deploys a brand-new, personally-owned `miner` canister, entirely from the
// browser, paid for in ICP:
//   1. Pay the Cycles Minting Canister in ICP (notify_create_canister) --
//      the same ICP-native "create a canister" flow icp-cli itself uses,
//      with this caller set as the new canister's sole controller and
//      PUBLIC_CANISTER_ID:mother wired in via canister settings so the
//      miner finds the right coordinator on its very first install.
//   2. Install the miner wasm (served as a static asset by this same site,
//      kept in sync with miner/.mops/.build/miner.wasm at build time --
//      see package.json's sync-miner-wasm script) onto that canister.
//   3. Send it fundMiningE8s of ICP -- what it will actually spend on
//      mining fees.
//   4. approveIcpFee() so it can pull that ICP from itself when it calls
//      mother, then start().
//
// Every step after canister creation is independently retriable if it
// fails partway -- the canister already exists and is already controlled
// by the caller at that point, so nothing here can strand funds beyond
// what's normal for any multi-step on-chain flow (a failed step just needs
// to be re-run, which is why this isn't wrapped in a single try/catch that
// would hide which step actually failed).
export async function deployMiner(
  identity: Identity,
  icpForCyclesE8s: bigint,
  fundMiningE8s: bigint,
  onProgress: (p: DeployProgress) => void,
): Promise<DeployResult> {
  const me = identity.getPrincipal();
  const cmcPrincipal = Principal.fromText(CMC_CANISTER_ID);
  const icpLedger = getIcpLedgerActor(identity);

  onProgress({ step: "paying", message: "Sending ICP to the Cycles Minting Canister..." });
  const transferResult = await icpLedger.icrc1_transfer({
    to: { owner: cmcPrincipal, subaccount: principalToSubaccount(me) },
    memo: MEMO_CREATE_CANISTER,
    amount: icpForCyclesE8s,
  });
  if (transferResult.__kind__ !== "Ok") {
    throw new Error(`ICP transfer to the CMC failed: ${describeError(transferResult.Err)}`);
  }
  const blockIndex = transferResult.Ok;

  onProgress({ step: "creating", message: "Creating your miner canister..." });
  const cmc = getCmcActor(identity);
  const createResult = await cmc.notify_create_canister({
    block_index: blockIndex,
    controller: me,
    settings: {
      controllers: [me],
      environment_variables: [{ name: "PUBLIC_CANISTER_ID:mother", value: motherCanisterId }],
    },
  });
  if (createResult.__kind__ !== "Ok") {
    throw new Error(`Canister creation failed: ${describeError(createResult.Err)}`);
  }
  const canisterId = createResult.Ok;
  const canisterIdText = canisterId.toText();

  onProgress({ step: "installing", message: "Installing the miner code..." });
  const wasmModule = new Uint8Array(await (await fetch("/miner.wasm")).arrayBuffer());
  const management = getManagementActorFor(canisterIdText, identity);
  await management.install_code({
    mode: { __kind__: "install", install: null },
    canister_id: canisterId,
    wasm_module: wasmModule,
    arg: new Uint8Array(),
  });

  onProgress({ step: "funding", message: "Sending it ICP to cover mining fees..." });
  const fundResult = await icpLedger.icrc1_transfer({
    to: { owner: canisterId },
    amount: fundMiningE8s,
  });
  if (fundResult.__kind__ !== "Ok") {
    throw new Error(
      `Miner was created (${canisterIdText}), but funding it with ICP failed: ${describeError(fundResult.Err)}. Send it ICP directly and finish setup manually.`,
    );
  }

  onProgress({ step: "approving", message: "Approving mother to pull the mining fee..." });
  const miner = getMinerActorAt(canisterIdText, identity);
  const approveResult = await miner.approveIcpFee(fundMiningE8s);
  if (approveResult.__kind__ !== "Ok") {
    throw new Error(
      `Miner was created and funded (${canisterIdText}), but approveIcpFee() failed: ${describeError(approveResult.Err)}. Call it again manually to finish setup.`,
    );
  }

  onProgress({ step: "starting", message: "Starting it mining..." });
  await miner.start();

  onProgress({ step: "done", message: "Mining, entirely on-chain -- close this tab whenever you like." });
  return { canisterId: canisterIdText };
}
