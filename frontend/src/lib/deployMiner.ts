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
import { Variant_keep_replace } from "../bindings/management/management";

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
// Same protocol as MEMO_CREATE_CANISTER, different operation -- see
// MEMO_TOP_UP_CANISTER in the same dfinity/ic source file.
const MEMO_TOP_UP_CANISTER = Uint8Array.from([0x54, 0x50, 0x55, 0x50, 0, 0, 0, 0]); // "TPUP", u64 LE

// The destination subnet deducts a flat 500B-cycle fee from whatever
// notify_create_canister receives, before this canister even exists to be
// installed into or funded -- verified live: a payment converting to just
// under that amount comes back #Refunded with "Creating a canister requires
// a fee of 500_000_000_000 ... but only N cycles were received". Requiring
// meaningfully more than the bare fee here (not just clearing it) leaves the
// new canister with real running room afterward, matching the balance the
// project's own mother/miner/frontend canisters actually run on day to day
// (see README).
const MIN_CYCLES_FOR_NEW_CANISTER = 1_200_000_000_000n; // 1.2T: 0.5T fee + 0.7T runway

// Mirrors the Cycles Minting Canister's own e8s -> cycles formula exactly
// (icp_e8s * xdr_permyriad_per_icp, verified against a real observed
// conversion: 30_000_000 e8s at a 15864 permyriad/ICP rate produced exactly
// 475_920_000_000 cycles) -- used to catch an ICP amount that's too small
// *before* spending it, rather than discovering it only after CMC refunds
// the payment. The ICP/XDR rate moves over time, so this is computed live
// on every deploy rather than assumed from a fixed constant, which is
// exactly the bug a hardcoded default ICP amount ran into.
async function estimateCycles(identity: Identity, icpE8s: bigint): Promise<bigint> {
  const cmc = getCmcActor(identity);
  const rate = await cmc.get_icp_xdr_conversion_rate();
  return icpE8s * rate.data.xdr_permyriad_per_icp;
}

// The live ICP amount (e8s) needed to clear MIN_CYCLES_FOR_NEW_CANISTER at
// today's rate -- used by DeployMiner.tsx to default the "ICP -> cycles"
// field to a value that's actually enough right now, instead of a fixed
// guess that quietly stops being enough as the rate moves (exactly what
// happened with the previous static "0.3 ICP" default).
export async function minIcpE8sForNewCanister(identity: Identity): Promise<bigint> {
  const cmc = getCmcActor(identity);
  const rate = await cmc.get_icp_xdr_conversion_rate();
  const perIcp = rate.data.xdr_permyriad_per_icp;
  // ceiling division: round up so the result never undershoots the floor
  return (MIN_CYCLES_FOR_NEW_CANISTER + perIcp - 1n) / perIcp;
}

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

// Thrown instead of a plain Error once the canister actually exists (i.e.
// from the "funding"/"approving"/"starting" steps onward) -- reported bug:
// a partial failure here (e.g. running out of ICP partway through) left the
// user with a real canister they'd already paid to create, but no way to
// find it again short of parsing a sentence of error text. Callers should
// catch this specifically to recover the id and offer a retry, rather than
// just displaying err.message.
export class DeployError extends Error {
  canisterId: string;
  constructor(message: string, canisterId: string) {
    super(message);
    this.name = "DeployError";
    this.canisterId = canisterId;
  }
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

  const expectedCycles = await estimateCycles(identity, icpForCyclesE8s);
  if (expectedCycles < MIN_CYCLES_FOR_NEW_CANISTER) {
    const neededE8s = await minIcpE8sForNewCanister(identity);
    throw new Error(
      `${(Number(icpForCyclesE8s) / 1e8).toFixed(4)} ICP would only convert to ` +
        `~${(Number(expectedCycles) / 1e12).toFixed(2)}T cycles at today's rate -- not enough to cover the ` +
        `network's 0.5T canister-creation fee plus real running room. Use at least ` +
        `${(Number(neededE8s) / 1e8).toFixed(4)} ICP for the "ICP -> cycles" field.`,
    );
  }

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
  try {
    const wasmModule = new Uint8Array(await (await fetch("/miner.wasm")).arrayBuffer());
    const management = getManagementActorFor(canisterIdText, identity);
    await management.install_code({
      mode: { __kind__: "install", install: null },
      canister_id: canisterId,
      wasm_module: wasmModule,
      arg: new Uint8Array(),
    });
  } catch (err) {
    throw new DeployError(
      `Installing the miner code failed: ${err instanceof Error ? err.message : describeError(err)}.`,
      canisterIdText,
    );
  }

  onProgress({ step: "funding", message: "Sending it ICP to cover mining fees..." });
  const fundResult = await icpLedger.icrc1_transfer({
    to: { owner: canisterId },
    amount: fundMiningE8s,
  });
  if (fundResult.__kind__ !== "Ok") {
    throw new DeployError(
      `Funding it with ICP failed: ${describeError(fundResult.Err)}.`,
      canisterIdText,
    );
  }

  onProgress({ step: "approving", message: "Approving mother to pull the mining fee..." });
  const miner = getMinerActorAt(canisterIdText, identity);
  const approveResult = await miner.approveIcpFee(fundMiningE8s);
  if (approveResult.__kind__ !== "Ok") {
    throw new DeployError(`approveIcpFee() failed: ${describeError(approveResult.Err)}.`, canisterIdText);
  }

  onProgress({ step: "starting", message: "Starting it mining..." });
  try {
    await miner.start();
  } catch (err) {
    throw new DeployError(
      `start() failed: ${err instanceof Error ? err.message : describeError(err)}.`,
      canisterIdText,
    );
  }

  onProgress({ step: "done", message: "Mining, entirely on-chain -- close this tab whenever you like." });
  return { canisterId: canisterIdText };
}

// Re-installs the miner wasm currently served at /miner.wasm onto an
// already-deployed miner canister, in upgrade mode (preserves state --
// mining status, PIKO/ICP/cycles balances, attempt counters). This is the
// only way an already-deployed miner ever picks up a bug fix or new
// feature shipped after it was created: this project's controller can't
// upgrade it (the deploying user is the sole controller, by design -- see
// deployMiner()'s notify_create_canister settings), so the fix has to be
// something the owner can trigger themselves, from their own browser, with
// their own identity. Exactly the same install_code call deployMiner()
// itself uses for the initial install, just in "upgrade" mode instead of
// "install".
export async function updateMinerCode(identity: Identity, canisterId: string): Promise<void> {
  const miner = getMinerActorAt(canisterId, identity);
  const management = getManagementActorFor(canisterId, identity);
  const targetPrincipal = Principal.fromText(canisterId);

  // Reported live: "canister_pre_upgrade attempted with outstanding message
  // callbacks (try stopping the canister before upgrade)". A mining miner's
  // timer fires every tickIntervalSeconds and each tick awaits an
  // inter-canister call to mother (getWork/submitProof) -- an upgrade that
  // lands while one of those is in flight traps outright, and a mining
  // miner is *always* at risk of exactly that, every few seconds. A miner
  // that had been stuck retrying a failed getWork() every tick (see
  // miner/src/main.mo's `ticking` guard, added after this exact symptom was
  // reported) could have *several* such calls genuinely in flight at once,
  // not just one -- a fixed sleep here previously guessed 5 seconds was
  // enough to outlast "one already in progress" and, live, it wasn't.
  //
  // Always stop first -- safe and idempotent even if it's already stopped
  // -- rather than checking getStatus().mining first (an earlier version
  // of this function did exactly that, and broke *every* call to it: the
  // whole reason to run this function at all is often to add a field like
  // pikoBalance that the currently-installed code doesn't return yet, so
  // requiring a successful, fully-decoded getStatus() call first made it
  // impossible to ever fix a miner that actually needed fixing). Left
  // stopped afterward on purpose -- resuming is the separate, explicit
  // Resume action, not something this function should decide on its own.
  await miner.stop();
  // miner.stop() only cancels *future* ticks (an app-level flag) -- it
  // can't wait out whatever's already in flight, which is exactly what the
  // trap above needs. management.stop_canister() is the actual fix: an
  // IC-protocol-level stop that doesn't return until every outstanding
  // inter-canister call this canister has sent has genuinely resolved, no
  // matter how many or how long that takes -- no guessed sleep duration
  // required. Safe to call even if nothing is outstanding (returns
  // immediately) and even though the canister is about to be stopped again
  // as a side effect of install_code's own upgrade semantics.
  await management.stop_canister({ canister_id: targetPrincipal });

  const wasmModule = new Uint8Array(await (await fetch("/miner.wasm")).arrayBuffer());
  await management.install_code({
    // Enhanced orthogonal persistence (this project builds with
    // --default-persistent-actors, see README) makes wasm_memory_persistence
    // a *required* choice on upgrade, not merely optional the way it reads
    // in the candid interface -- omitting it entirely gets rejected outright
    // ("Missing upgrade option"), found by actually clicking this button
    // rather than trusting it type-checked. "keep" is what an upgrade is
    // supposed to mean here: preserve the canister's persisted state
    // (mining status, PIKO/ICP/cycles balances) across the code change --
    // "replace" would wipe it, equivalent to a reinstall.
    mode: { __kind__: "upgrade", upgrade: { wasm_memory_persistence: Variant_keep_replace.keep } },
    canister_id: targetPrincipal,
    wasm_module: wasmModule,
    arg: new Uint8Array(),
  });

  // A canister the IC considers "Stopped" rejects every call -- including
  // plain queries like getStatus() -- so this has to bring it back to
  // "Running" before returning, even though the *app-level* mining flag
  // (already false from miner.stop() above, and untouched by any of this)
  // stays exactly as intentionally left: idle until an explicit Resume.
  await management.start_canister({ canister_id: targetPrincipal });
}

// Sends more ICP straight to an already-deployed miner canister's own
// balance -- exactly what deployMiner()'s "funding" step does, exposed on
// its own so a partially-set-up (or simply low-on-funds) miner can be
// topped up later without redeploying anything.
export async function fundMinerIcp(identity: Identity, canisterId: string, amountE8s: bigint): Promise<void> {
  const icpLedger = getIcpLedgerActor(identity);
  const result = await icpLedger.icrc1_transfer({
    to: { owner: Principal.fromText(canisterId) },
    amount: amountE8s,
  });
  if (result.__kind__ !== "Ok") {
    throw new Error(`Sending ICP failed: ${describeError(result.Err)}`);
  }
}

// Converts ICP into *cycles* for an already-deployed miner -- unrelated to
// fundMinerIcp above (that sends ICP the miner spends on mining fees; this
// pays the CMC to top up the miner's own compute budget). Needed for
// updateMinerCode() above in particular: install_code costs real cycles on
// top of the canister's ordinary running costs, and a miner that's been
// running a while on whatever cycles it was created with can run short --
// reported live: "please top up the canister with at least N additional
// cycles" from a real upgrade attempt. Subaccount is principalToSubaccount
// of the *target canister*, not the payer -- the opposite of
// MEMO_CREATE_CANISTER's subaccount above, since there's no new controller
// to record, only an existing canister to credit. Mirrors mother's own
// sweepTreasury(), which does the same thing to fund itself.
export async function topUpMinerCycles(identity: Identity, canisterId: string, icpE8s: bigint): Promise<void> {
  const cmcPrincipal = Principal.fromText(CMC_CANISTER_ID);
  const target = Principal.fromText(canisterId);
  const icpLedger = getIcpLedgerActor(identity);
  const transferResult = await icpLedger.icrc1_transfer({
    to: { owner: cmcPrincipal, subaccount: principalToSubaccount(target) },
    memo: MEMO_TOP_UP_CANISTER,
    amount: icpE8s,
  });
  if (transferResult.__kind__ !== "Ok") {
    throw new Error(`ICP transfer to the CMC failed: ${describeError(transferResult.Err)}`);
  }
  const cmc = getCmcActor(identity);
  const notifyResult = await cmc.notify_top_up({ block_index: transferResult.Ok, canister_id: target });
  if (notifyResult.__kind__ !== "Ok") {
    throw new Error(`notify_top_up failed: ${describeError(notifyResult.Err)}`);
  }
}

// Re-runs approveIcpFee() + start() on an already-deployed miner --
// exactly deployMiner()'s last two steps, exposed on their own so a miner
// that was created (and possibly funded) but never finished setup can be
// resumed without paying to create a second canister.
export async function finishMinerSetup(identity: Identity, canisterId: string, approveAmountE8s: bigint): Promise<void> {
  const miner = getMinerActorAt(canisterId, identity);
  const approveResult = await miner.approveIcpFee(approveAmountE8s);
  if (approveResult.__kind__ !== "Ok") {
    throw new Error(`approveIcpFee() failed: ${describeError(approveResult.Err)}`);
  }
  await miner.start();
}
