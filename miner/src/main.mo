import Principal "mo:core/Principal";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Runtime "mo:core/Runtime";
import Timer "mo:core/Timer";
import Sha256 "mo:sha2/Sha256";
import Types "types";

// PIKO reference miner: a template canister a user deploys and tops up with
// cycles to mine PIKO against the `mother` coordinator canister, mirroring
// the "each miner deploys their own canister" design described by the user.
actor self {

  // ---- Wiring ----
  let motherId : Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:mother")) {
    case (?text) { Principal.fromText(text) };
    case null {
      Runtime.trap("PUBLIC_CANISTER_ID:mother is not set -- deploy the `mother` canister first");
    };
  };
  let Mother : Types.MotherActor = actor (Principal.toText(motherId));

  // The real, mainnet ICP ledger -- mother charges (and burns) the mining
  // fee via icrc2_transfer_from, which requires this canister to have
  // approved mother as a spender first (see approveIcpFee()) and to hold
  // enough ICP to actually pay it.
  var icpLedgerId : Principal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");

  // The identity that deployed this canister is its controller and the
  // intended owner/beneficiary of anything it mines.
  var owner : Principal = Principal.fromText("2vxsx-fae"); // placeholder, set on first start()

  // ---- Mining state ----
  var mining : Bool = false;
  var nextNonce : Nat = 0;
  var attempts : Nat = 0;
  var blocksFound : Nat = 0;
  var lastError : ?Text = null;

  // How many hashes to attempt per timer tick, and how often to tick. Kept
  // conservative by default to stay well under the per-message instruction
  // limit; raise batchSizePerTick once you've measured actual cost on your
  // target network (see README).
  var batchSizePerTick : Nat = 20_000;
  var tickIntervalSeconds : Nat = 3;
  // Attached to each submitProof call as its cycles fee. mother accepts any
  // amount of attached cycles opportunistically (never requires it -- see
  // mother/src/main.mo), so this is just a voluntary top-up, not a required
  // minimum.
  var feeCyclesPerSubmit : Nat = 1_000_000_000;

  transient var timerId : ?Timer.TimerId = null;
  // Reentrancy guard for tick() -- see its own comment for why this matters.
  transient var ticking : Bool = false;

  // ---- Hashing (must stay byte-for-byte identical to mother/src/main.mo) ----

  func natToBytes8(n : Nat) : [Nat8] {
    let n64 = Nat64.fromNat(n);
    Array.tabulate<Nat8>(
      8,
      func(i) {
        let shift = Nat64.fromNat((7 - i) * 8);
        Nat8.fromNat(Nat64.toNat((n64 >> shift) & 0xFF));
      },
    );
  };

  func leadingZeroBits(b : Blob) : Nat {
    let bytes = Blob.toArray(b);
    var count = 0;
    label scan for (byte in bytes.vals()) {
      if (byte == 0) {
        count += 8;
      } else {
        var v = byte;
        var i = 0;
        while (i < 8 and (v & 0x80) == 0) {
          count += 1;
          v := v << 1;
          i += 1;
        };
        break scan;
      };
    };
    count;
  };

  // previousHash and height are the same for every attempt within a batch
  // -- only the nonce actually varies. headerBytes() below builds that
  // constant prefix once per tick instead of once per attempt (the
  // in-browser worker already does this -- see
  // frontend/src/worker/miner.worker.ts's `header`). Re-deriving it from
  // scratch on every single hash, as this used to, meant paying real
  // cycles to redo the same Blob.toArray + Array.concat work millions of
  // times per submission for no reason: real waste, since it's the
  // canister (not the caller) that pays for every attempt, successful or
  // not -- unlike browser mining, where failed attempts cost nothing.
  // Output is byte-for-byte identical either way (concatenation is
  // associative), just computed cheaper.
  func headerBytes(prev : Blob, atHeight : Nat) : [Nat8] {
    Array.concat(Blob.toArray(prev), natToBytes8(atHeight));
  };

  func hashWithHeader(header : [Nat8], nonce : Nat) : Blob {
    Sha256.fromArray(#sha256, Array.concat(header, natToBytes8(nonce)));
  };

  // ---- Mining loop ----

  func tick<system>() : async () {
    if (not mining) { return };
    // A tick that's still awaiting getWork()/submitProof() below can still
    // be in flight when the *next* recurring-timer firing calls tick()
    // again -- Timer.recurringTimer doesn't wait for the previous call to
    // finish, and async functions are reentrant by default in Motoko, so
    // nothing stops that on its own. Once real-world round-trip time to
    // `mother` (consensus + network) exceeds tickIntervalSeconds even
    // occasionally, overlapping ticks compound: each one queues its own
    // outbound call, the canister's outstanding-call queue saturates, and
    // *every* getWork() attempt starts failing immediately (a synchronous
    // reject, indistinguishable from a real failure once caught below) --
    // a self-inflicted traffic jam that never clears on its own, since a
    // getWork() failure doesn't stop mining or cancel the timer. Skipping
    // any tick that finds one already in flight is what actually prevents
    // the pile-up, rather than just reacting to it after the fact.
    if (ticking) { return };
    ticking := true;

    // Recomputed from the current feeCyclesPerSubmit on every tick (rather
    // than a fixed constant) so the safety margin stays correct even after
    // setFeeCyclesPerSubmit changes it -- a stale, too-low threshold here
    // could let the canister burn through cycles past the point it can
    // still afford to run.
    let minCyclesToMine = 2 * feeCyclesPerSubmit;
    if (Cycles.balance() < minCyclesToMine) {
      mining := false;
      cancelTimer();
      lastError := ?"stopped: cycle balance too low, call deposit() then start() again";
      ticking := false;
      return;
    };

    let work = try { ?(await Mother.getWork()) } catch (_e) { null };
    let w = switch (work) {
      case (?w) { w };
      case null { lastError := ?"getWork() call failed"; ticking := false; return };
    };

    let header = headerBytes(w.previousHash, w.height);
    var nonce = nextNonce;
    var found : ?Nat = null;
    var i = 0;
    label search while (i < batchSizePerTick) {
      let candidate = hashWithHeader(header, nonce);
      attempts += 1;
      if (leadingZeroBits(candidate) >= w.difficultyBits) {
        found := ?nonce;
        break search;
      };
      nonce += 1;
      i += 1;
    };
    nextNonce := nonce;

    switch (found) {
      case null {};
      case (?n) {
        let result = try {
          ?(await (with cycles = feeCyclesPerSubmit) Mother.submitProof(n));
        } catch (_e) { null };
        switch (result) {
          case (? #Ok(_ok)) { blocksFound += 1; lastError := null };
          case (? #Err(#IcpFeeFailed(#InsufficientFunds(_)))) {
            // The ICP funding this miner approved is gone -- stop instead of
            // keep grinding (each further tick would still spend real
            // cycles on a hash search and a submitProof call that's doomed
            // to fail the same way). Send more ICP to this canister and
            // call approveIcpFee() again to resume.
            mining := false;
            cancelTimer();
            lastError := ?"stopped: out of ICP for the mining fee -- send more ICP here, then approveIcpFee() + start() again";
          };
          case (? #Err(#IcpFeeFailed(#InsufficientAllowance(_)))) {
            // Same idea, but the ICP is still here -- only the approved
            // allowance ran out (e.g. it was sized for N blocks and N have
            // been mined). approveIcpFee() alone is enough to resume.
            mining := false;
            cancelTimer();
            lastError := ?"stopped: ICP allowance for mother exhausted -- approveIcpFee() again, then start()";
          };
          case (? #Err(e)) { lastError := ?debug_show (e) };
          case null { lastError := ?"submitProof() call failed" };
        };
      };
    };
    ticking := false;
  };

  func cancelTimer() {
    switch (timerId) {
      case (?id) { Timer.cancelTimer(id) };
      case null {};
    };
    timerId := null;
  };

  func armTimer<system>() {
    cancelTimer();
    timerId := ?Timer.recurringTimer<system>(#seconds tickIntervalSeconds, tick);
  };

  // Timers do not survive upgrades; re-arm automatically if we were mining.
  system func postupgrade() {
    if (mining) { armTimer<system>() };
  };

  // ---- Admin (owner/controller-only) ----

  func requireOwner(caller : Principal) {
    // `owner` starts out as the anonymous principal (a placeholder until the
    // real owner's first start() call sets it) -- explicitly rejecting
    // anonymous callers here, rather than only checking `caller != owner`,
    // closes the window where that placeholder equals the caller and an
    // unauthenticated party could operate this canister before it's ever
    // been configured.
    if (Principal.isAnonymous(caller)) {
      Runtime.trap("anonymous callers cannot control this miner");
    };
    if (not Principal.isController(caller) and caller != owner) {
      Runtime.trap("only the owner/controller of this miner can call this");
    };
  };

  public shared ({ caller }) func start<system>() : async () {
    requireOwner(caller);
    if (Principal.isController(caller)) { owner := caller };

    // Same threshold tick() itself checks -- mirrored here so a start()
    // with an empty tank fails fast with a clear reason instead of arming
    // the timer and burning a tick's worth of hashing + a doomed
    // submitProof before tick() discovers the same thing.
    let minCyclesToMine = 2 * feeCyclesPerSubmit;
    if (Cycles.balance() < minCyclesToMine) {
      lastError := ?"cannot start: cycle balance too low, call deposit() first";
      return;
    };

    let work = try { ?(await Mother.getWork()) } catch (_e) { null };
    switch (work) {
      case null {
        lastError := ?"cannot start: getWork() call failed, try again";
        return;
      };
      case (?w) {
        let IcpLedger : Types.IcpLedgerActor = actor (Principal.toText(icpLedgerId));
        let icpBalance = try {
          await IcpLedger.icrc1_balance_of({ owner = Principal.fromActor(self); subaccount = null });
        } catch (_e) { 0 };
        if (icpBalance < w.miningFeeE8s) {
          lastError := ?"cannot start: not enough ICP for the mining fee, send more ICP here then start() again";
          return;
        };
      };
    };

    mining := true;
    lastError := null;
    armTimer<system>();
  };

  public shared ({ caller }) func stop() : async () {
    requireOwner(caller);
    mining := false;
    // A manual stop is never itself an error, but tick()'s own transient
    // failures (e.g. "getWork() call failed") never clear lastError on
    // their own -- they just leave it for the next tick to overwrite once
    // mining succeeds again. If a stop() lands while one of those is the
    // last-reported error, leaving it in place would make a canister that's
    // now genuinely idle look like it's still actively retrying.
    lastError := null;
    cancelTimer();
  };

  public shared ({ caller }) func setBatchSizePerTick(n : Nat) : async () {
    requireOwner(caller);
    batchSizePerTick := n;
  };

  public shared ({ caller }) func setTickIntervalSeconds<system>(n : Nat) : async () {
    requireOwner(caller);
    tickIntervalSeconds := n;
    if (mining) { armTimer<system>() };
  };

  public shared ({ caller }) func setFeeCyclesPerSubmit(n : Nat) : async () {
    requireOwner(caller);
    feeCyclesPerSubmit := n;
  };

  // Anyone can top up a miner with cycles (standard cycles-management
  // pattern: attach cycles to this call).
  public shared func deposit<system>() : async Nat {
    Cycles.accept<system>(Cycles.available());
  };

  // Approves `mother` to pull up to `amountE8s` in mining fees from this
  // canister's own ICP balance (this canister must already hold that much
  // ICP -- send it to this canister's principal like any ICRC-1 account).
  // Only needs to be called again once the allowance runs low.
  public shared ({ caller }) func approveIcpFee<system>(amountE8s : Nat) : async Types.ApproveResult {
    requireOwner(caller);
    let IcpLedger : Types.IcpLedgerActor = actor (Principal.toText(icpLedgerId));
    await IcpLedger.icrc2_approve({
      fee = null;
      memo = null;
      from_subaccount = null;
      created_at_time = null;
      amount = amountE8s;
      expected_allowance = null;
      expires_at = null;
      spender = { owner = motherId; subaccount = null };
    });
  };

  // Only meant for pointing this canister at a local test ICRC ledger while
  // developing (the real ICP ledger only exists on mainnet).
  public shared ({ caller }) func setIcpLedger(ledgerId : Principal) : async () {
    requireOwner(caller);
    icpLedgerId := ledgerId;
  };

  // Sends `amountE8s` of this canister's own ICP balance to `to`. Without
  // this, ICP sent here to fund mining fees would have no way out short of
  // a code upgrade -- the only other ICP-moving path is mother pulling the
  // mining fee via the allowance from approveIcpFee().
  public shared ({ caller }) func withdrawIcp(to : Principal, amountE8s : Nat) : async Types.TransferResult {
    requireOwner(caller);
    let IcpLedger : Types.IcpLedgerActor = actor (Principal.toText(icpLedgerId));
    await IcpLedger.icrc1_transfer({
      from_subaccount = null;
      to = { owner = to; subaccount = null };
      amount = amountE8s;
      fee = null;
      memo = null;
      created_at_time = null;
    });
  };

  // A block won by this miner mints PIKO to *this canister's own*
  // principal -- mother pays whoever called submitProof, and for a
  // deployed miner that's this canister, not its owner. Without this,
  // every block a deployed miner ever wins would be permanently stuck
  // here, since the only other ICP-moving function (withdrawIcp above)
  // only knows about icpLedgerId, not PIKO's ledger. Looks up the PIKO
  // ledger's id live via mother.getStats() rather than caching it, so
  // this works even for a miner that was deployed before this function
  // (or a PUBLIC_CANISTER_ID:ledger env var) existed.
  public shared ({ caller }) func withdrawPiko(to : Principal, amount : Nat) : async Types.TransferResult {
    requireOwner(caller);
    // Local, not the top-level `Mother` -- see MotherStatsActor's own
    // comment in types.mo for why this can't just be added to Mother's
    // declared type.
    let MotherStats : Types.MotherStatsActor = actor (Principal.toText(motherId));
    let stats = await MotherStats.getStats();
    let PikoLedger : Types.IcpLedgerActor = actor (Principal.toText(stats.ledgerId));
    await PikoLedger.icrc1_transfer({
      from_subaccount = null;
      to = { owner = to; subaccount = null };
      amount;
      fee = null;
      memo = null;
      created_at_time = null;
    });
  };

  public func getStatus() : async Types.Status {
    let IcpLedger : Types.IcpLedgerActor = actor (Principal.toText(icpLedgerId));
    let icpBalanceE8s = try {
      await IcpLedger.icrc1_balance_of({ owner = Principal.fromActor(self); subaccount = null });
    } catch (_e) { 0 };
    let pikoBalance = try {
      let MotherStats : Types.MotherStatsActor = actor (Principal.toText(motherId));
      let stats = await MotherStats.getStats();
      let PikoLedger : Types.IcpLedgerActor = actor (Principal.toText(stats.ledgerId));
      await PikoLedger.icrc1_balance_of({ owner = Principal.fromActor(self); subaccount = null });
    } catch (_e) { 0 };
    {
      mining;
      owner;
      motherId;
      attempts;
      blocksFound;
      nextNonce;
      batchSizePerTick;
      tickIntervalSeconds;
      feeCyclesPerSubmit;
      cyclesBalance = Cycles.balance();
      icpBalanceE8s;
      pikoBalance;
      lastError;
    };
  };
};
