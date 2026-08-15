import Principal "mo:core/Principal";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Blob "mo:core/Blob";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Time "mo:core/Time";
import Cycles "mo:core/Cycles";
import Runtime "mo:core/Runtime";
import Timer "mo:core/Timer";
import Map "mo:core/Map";
import Types "types";

// PIKO casino: a provably-fair, fully on-chain dice game, self-funded in
// cycles the same way `mother` is. Built as a companion to PIKO mining --
// see README -- to give PIKO (and ICP) something to do besides sit in a
// wallet, without ever touching fiat or requiring KYC: every stake and
// every payout is an ICRC-1/ICRC-2 transfer between principals, nothing
// off-chain, no human arbiter.
//
// The odds are the standard "roll under" crypto-dice formula (the same one
// used across the space, e.g. Stake.com's dice game): pick a target in
// [minTarget, maxTarget], win if a fresh on-chain random roll in [0, 99] is
// strictly below it, and get paid payoutNumerator/target times your stake.
// payoutNumerator is 99 (not 100), which is exactly what encodes the 1%
// house edge: expected return = (target/100) * (99/target) = 0.99. Fixed at
// compile time, never admin-settable -- unlike miningFeeE8s in mother, the
// odds are not something a controller should ever be able to move.
actor self {

  // ---- Game constants ----
  let MIN_TARGET : Nat = 2;
  let MAX_TARGET : Nat = 98;
  let PAYOUT_NUMERATOR : Nat = 99;

  // ---- Ledger wiring ----
  // PIKO's own ledger -- injected the same way mother finds it (see
  // "Canister Discovery" in the icp-cli docs). Named `ledger` in icp.yaml,
  // same as mother's own dependency.
  let pikoLedgerId : Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:ledger")) {
    case (?text) { Principal.fromText(text) };
    case null {
      Runtime.trap("PUBLIC_CANISTER_ID:ledger is not set -- deploy the `ledger` canister first");
    };
  };

  // Real mainnet ICP ledger by default; `var` (not `let`) purely so this can
  // be pointed at a local test ledger while developing, exactly like
  // mother's own icpLedgerId -- never redirectable post-launch (there is no
  // propose/execute path for it at all, unlike mother's icpFeeTarget, since
  // nothing here needs to move where fees are burned).
  var icpLedgerId : Principal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  var cmcId : Principal = Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai");

  func ledgerIdFor(token : Types.TokenKind) : Principal {
    switch (token) { case (#ICP) { icpLedgerId }; case (#PIKO) { pikoLedgerId } };
  };

  // ---- Risk configuration (timelocked, see types.mo's RiskConfig) ----
  // maxPayoutBps: the biggest single-bet payout this canister will ever
  // accept, as a fraction of the *current* bankroll for that bet's token --
  // recomputed live on every bet from the real ledger balance, never from a
  // cached counter, so it can never be fooled by stale state. 100 bps (1%)
  // to start: conservative on purpose while the bankroll is thin (see
  // README/forum post -- this launches with a small, self-seeded bankroll).
  // icpBankrollFloorE8s: sweepIcpProfit() below never touches ICP under this
  // line -- only genuine profit above it is eligible to fund cycles. Starts
  // at 0 (nothing seeded yet); raise it (timelocked) once real ICP has been
  // deposited as bankroll.
  // cyclesFundRatioBps: same role, same default (2000 = 20%), as mother's
  // own field of the same name.
  var riskConfig : Types.RiskConfig = {
    maxPayoutBps = 100;
    icpBankrollFloorE8s = 0;
    cyclesFundRatioBps = 2000;
  };
  var riskConfigLocked : Bool = false;

  let ICP_LEDGER_FEE_E8S : Nat = 10_000;
  let SWEEP_INTERVAL_SECONDS : Nat = 3600; // 1h, same cadence as mother
  transient var sweepTimerId : ?Timer.TimerId = null;

  // ---- Bet state ----
  // In-flight lock, not a cooldown: a caller with an unresolved bet can't
  // start a second one until this one clears (success, failure, or refund),
  // closing off any reentrancy path through the awaits in placeBet below.
  // Transient like mother's lastAttempt -- resetting on upgrade is safe,
  // nothing here is owed to anyone (a bet that was truly mid-flight during
  // an upgrade never happened from the ledger's point of view either, since
  // the stake pull and the payout are each a single atomic transfer).
  transient let pendingBets : Map.Map<Principal, Bool> = Map.empty<Principal, Bool>();

  // Owed-but-unpaid payouts (a transfer back to the winner trapped or
  // errored) -- persisted, exactly like mother's pendingRewards, since this
  // is real money owed to a specific player. Two separate maps rather than
  // one keyed by (Principal, TokenKind): this project's existing style
  // (mother/miner) prefers explicit, separate state over generic composite
  // keys, and there are only ever two tokens here.
  let pendingIcpPayouts : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
  let pendingPikoPayouts : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();

  // Cumulative stats -- persisted, purely informational (getStats()).
  var betsPlaced : Nat = 0;
  var betsWon : Nat = 0;
  var totalWageredIcpE8s : Nat = 0;
  var totalWageredPiko : Nat = 0;
  var totalPaidOutIcpE8s : Nat = 0;
  var totalPaidOutPiko : Nat = 0;

  let MAX_RECENT_BETS : Nat = 20;
  var recentBets : [Types.RecentBet] = [];

  // Per-player wagered volume, one map per token -- see LeaderboardEntry in
  // types.mo for why these are never summed together.
  let playerWageredIcp : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
  let playerWageredPiko : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();

  // ---- Helpers ----

  func addToMap(m : Map.Map<Principal, Nat>, p : Principal, amount : Nat) {
    let current = switch (Map.get(m, Principal.compare, p)) {
      case (?v) { v };
      case null { 0 };
    };
    Map.add(m, Principal.compare, p, current + amount);
  };

  func pushRecentBet(b : Types.RecentBet) {
    let combined = Array.concat(recentBets, [b]);
    let n = combined.size();
    recentBets := if (n > MAX_RECENT_BETS) {
      Array.tabulate<Types.RecentBet>(MAX_RECENT_BETS, func(i) { combined[n - MAX_RECENT_BETS + i] });
    } else { combined };
  };

  // First 4 bytes of a fresh raw_rand() blob, folded into [0, 99]. raw_rand
  // returns 32 cryptographically random bytes from the subnet's own
  // threshold randomness beacon -- using only 4 of them is already far more
  // entropy than a 2-digit outcome needs; there's no reason to mix in more.
  func rollFromBytes(b : Blob) : Nat {
    let bytes = Blob.toArray(b);
    var n : Nat = 0;
    var i = 0;
    while (i < 4) {
      n := n * 256 + Nat8.toNat(bytes[i]);
      i += 1;
    };
    n % 100;
  };

  // Pays `amount` to `to` on `token`'s ledger. On failure, the amount is
  // recorded as a pending payout the player can retry via
  // claimPendingPayout() -- mirrors payReward() in mother/src/main.mo
  // exactly, same reasoning: a failed transfer must never mean a won bet
  // silently loses its payout.
  func pay(token : Types.TokenKind, to : Principal, amount : Nat) : async () {
    let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerIdFor(token)));
    let outcome = try {
      ?(
        await Ledger.icrc1_transfer({
          from_subaccount = null;
          to = { owner = to; subaccount = null };
          amount;
          fee = null;
          memo = null;
          created_at_time = null;
        })
      );
    } catch (_e) { null };

    switch (outcome) {
      case (? #Ok(_)) {};
      case (_) {
        switch (token) {
          case (#ICP) { addToMap(pendingIcpPayouts, to, amount) };
          case (#PIKO) { addToMap(pendingPikoPayouts, to, amount) };
        };
      };
    };
  };

  // ---- Public API ----

  public query func getConfig() : async Types.Config {
    {
      minTarget = MIN_TARGET;
      maxTarget = MAX_TARGET;
      payoutNumerator = PAYOUT_NUMERATOR;
      maxPayoutBps = riskConfig.maxPayoutBps;
      icpBankrollFloorE8s = riskConfig.icpBankrollFloorE8s;
      cyclesFundRatioBps = riskConfig.cyclesFundRatioBps;
      withdrawalsLocked;
      icpLedgerId;
      pikoLedgerId;
    };
  };

  public func getStats() : async Types.Stats {
    let IcpLedger : Types.LedgerActor = actor (Principal.toText(icpLedgerId));
    let PikoLedger : Types.LedgerActor = actor (Principal.toText(pikoLedgerId));
    let self_ = Principal.fromActor(self);
    let icpBankrollE8s = try {
      await IcpLedger.icrc1_balance_of({ owner = self_; subaccount = null });
    } catch (_e) { 0 };
    let pikoBankroll = try {
      await PikoLedger.icrc1_balance_of({ owner = self_; subaccount = null });
    } catch (_e) { 0 };
    {
      betsPlaced;
      betsWon;
      totalWageredIcpE8s;
      totalWageredPiko;
      totalPaidOutIcpE8s;
      totalPaidOutPiko;
      icpBankrollE8s;
      pikoBankroll;
      cyclesBalance = Cycles.balance();
    };
  };

  public query func getRecentBets() : async [Types.RecentBet] { recentBets };

  // Ranked by PIKO wagered -- the casino-frontend/ site only ever offers
  // PIKO bets (see its Dice.tsx), so ICP volume is not a meaningful sort
  // key even though it's still tracked (see LeaderboardEntry in types.mo
  // for why PIKO and ICP volume are never summed). Built from the union of
  // both maps' keys, since a player who has only ever bet PIKO (or only
  // ICP) must still show up with a real 0 on the other side, not be left
  // out.
  public query func getLeaderboard() : async [Types.LeaderboardEntry] {
    let seen : Map.Map<Principal, Bool> = Map.empty<Principal, Bool>();
    for (p in Map.keys(playerWageredIcp)) { Map.add(seen, Principal.compare, p, true) };
    for (p in Map.keys(playerWageredPiko)) { Map.add(seen, Principal.compare, p, true) };

    let entries = Array.map<Principal, Types.LeaderboardEntry>(
      Iter.toArray(Map.keys(seen)),
      func(p) {
        let wageredIcpE8s = switch (Map.get(playerWageredIcp, Principal.compare, p)) {
          case (?v) { v };
          case null { 0 };
        };
        let wageredPiko = switch (Map.get(playerWageredPiko, Principal.compare, p)) {
          case (?v) { v };
          case null { 0 };
        };
        { player = p; wageredIcpE8s; wageredPiko };
      },
    );
    let sorted = Array.sort<Types.LeaderboardEntry>(entries, func(a, b) { Nat.compare(b.wageredPiko, a.wageredPiko) });
    if (sorted.size() > 10) {
      Array.tabulate<Types.LeaderboardEntry>(10, func(i) { sorted[i] });
    } else { sorted };
  };

  public query ({ caller }) func getPendingPayout(token : Types.TokenKind) : async Nat {
    let m = switch (token) { case (#ICP) { pendingIcpPayouts }; case (#PIKO) { pendingPikoPayouts } };
    switch (Map.get(m, Principal.compare, caller)) {
      case (?v) { v };
      case null { 0 };
    };
  };

  public shared ({ caller }) func claimPendingPayout(token : Types.TokenKind) : async Types.BetResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    let m = switch (token) { case (#ICP) { pendingIcpPayouts }; case (#PIKO) { pendingPikoPayouts } };
    let owed = switch (Map.get(m, Principal.compare, caller)) {
      case (?v) { v };
      case null { 0 };
    };
    if (owed == 0) { return #Err(#InvalidAmount) };
    Map.remove(m, Principal.compare, caller); // clear before await -- no double-claim
    await pay(token, caller, owed);
    #Ok({ roll = 0; won = true; payoutAmount = owed });
  };

  // Verifies the target, checks the caller isn't already mid-bet, sizes the
  // bet against the *live* bankroll (never a cached figure), pulls the
  // stake via icrc2_transfer_from (the player must icrc2_approve this
  // canister first), and only then draws randomness. That ordering is what
  // makes this safe without a separate commit-reveal step: the stake is
  // already gone, atomically, before raw_rand() is ever called, so there is
  // no point at which the caller can see the outcome and still back out.
  public shared ({ caller }) func placeBet<system>(token : Types.TokenKind, amountE8s : Nat, target : Nat) : async Types.BetResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    if (target < MIN_TARGET or target > MAX_TARGET) { return #Err(#InvalidTarget) };
    if (amountE8s == 0) { return #Err(#InvalidAmount) };
    if (Map.get(pendingBets, Principal.compare, caller) != null) {
      return #Err(#BetInProgress);
    };
    // Locked here, synchronously, before the first await below -- not
    // after it. A caller's synchronous prefix (including this check) can
    // otherwise interleave with another in-flight call of theirs across an
    // await boundary: if the lock were only written post-await, a burst of
    // concurrent placeBet calls from the same principal would each read
    // the same not-yet-locked, not-yet-drawn-down bankroll and each get
    // independently approved against maxPayoutBps, so the aggregate
    // approved exposure across the burst would scale with the number of
    // concurrent calls instead of staying capped at a single bet's share.
    Map.add(pendingBets, Principal.compare, caller, true);

    let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerIdFor(token)));
    let bankroll = try {
      await Ledger.icrc1_balance_of({ owner = Principal.fromActor(self); subaccount = null });
    } catch (_e) { 0 };

    let payoutAmount = amountE8s * PAYOUT_NUMERATOR / target;
    let maxPayoutAllowed = bankroll * riskConfig.maxPayoutBps / 10_000;
    if (payoutAmount > maxPayoutAllowed) {
      Map.remove(pendingBets, Principal.compare, caller);
      return #Err(#BetTooLarge({ maxPayout = maxPayoutAllowed }));
    };

    let pullOutcome = try {
      ?(
        await Ledger.icrc2_transfer_from({
          spender_subaccount = null;
          from = { owner = caller; subaccount = null };
          to = { owner = Principal.fromActor(self); subaccount = null };
          amount = amountE8s;
          fee = null;
          memo = null;
          created_at_time = null;
        })
      );
    } catch (_e) { null };

    switch (pullOutcome) {
      case (? #Ok(_)) {};
      case (? #Err(e)) {
        Map.remove(pendingBets, Principal.compare, caller);
        return #Err(#TransferFailed(e));
      };
      case null {
        Map.remove(pendingBets, Principal.compare, caller);
        return #Err(#TransferFailed(#TemporarilyUnavailable));
      };
    };

    // Committed from here on: the stake already left the player's control.
    // If randomness genuinely can't be drawn, refund rather than strand it
    // -- via the same pending-payout path a failed win payout uses, so a
    // second failure (the refund transfer itself) is never silently lost.
    let Management : Types.ManagementActor = actor ("aaaaa-aa");
    let randOutcome = try { ?(await Management.raw_rand()) } catch (_e) { null };
    Map.remove(pendingBets, Principal.compare, caller);
    let roll = switch (randOutcome) {
      case (?bytes) { rollFromBytes(bytes) };
      case null {
        await pay(token, caller, amountE8s); // refund
        return #Err(#RandomnessFailed);
      };
    };

    betsPlaced += 1;
    let won = roll < target;
    let confirmedNow = Time.now();
    let actualPayout = if (won) { payoutAmount } else { 0 };
    if (won) { betsWon += 1 };

    switch (token) {
      case (#ICP) {
        totalWageredIcpE8s += amountE8s;
        if (won) { totalPaidOutIcpE8s += actualPayout };
        addToMap(playerWageredIcp, caller, amountE8s);
      };
      case (#PIKO) {
        totalWageredPiko += amountE8s;
        if (won) { totalPaidOutPiko += actualPayout };
        addToMap(playerWageredPiko, caller, amountE8s);
      };
    };

    pushRecentBet({
      player = caller;
      token;
      amount = amountE8s;
      target;
      roll;
      won;
      payoutAmount = actualPayout;
      timestamp = confirmedNow;
    });

    if (won) { await pay(token, caller, actualPayout) };

    #Ok({ roll; won; payoutAmount = actualPayout });
  };

  // ---- Admin (controller-only, timelocked -- see types.mo's RiskConfig/PendingWithdrawal) ----

  func requireController(caller : Principal) {
    if (not Principal.isController(caller)) {
      Runtime.trap("only a controller can call this");
    };
  };

  let ADMIN_TIMELOCK_NANOS : Int = 48 * 60 * 60 * 1_000_000_000; // 48h, same as mother

  var pendingRiskConfig : ?Types.PendingRiskConfig = null;
  var pendingWithdrawal : ?Types.PendingWithdrawal = null;
  var withdrawalsLocked : Bool = false;

  public query func getPendingAdminChanges() : async Types.PendingAdminChanges {
    { riskConfig = pendingRiskConfig; withdrawal = pendingWithdrawal; timelockNanos = ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func proposeRiskConfig(value : Types.RiskConfig) : async () {
    requireController(caller);
    if (riskConfigLocked) { Runtime.trap("risk config is permanently locked") };
    if (value.cyclesFundRatioBps > 10_000) {
      Runtime.trap("cyclesFundRatioBps must be <= 10000 (100%)");
    };
    if (value.maxPayoutBps > 10_000) {
      Runtime.trap("maxPayoutBps must be <= 10000 (100%)");
    };
    pendingRiskConfig := ?{ value; readyAt = Time.now() + ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func cancelPendingRiskConfig() : async () {
    requireController(caller);
    pendingRiskConfig := null;
  };

  public shared func executeRiskConfig() : async () {
    switch (pendingRiskConfig) {
      case null { Runtime.trap("no pending risk config change") };
      case (?p) {
        if (Time.now() < p.readyAt) { Runtime.trap("timelock has not elapsed yet") };
        if (riskConfigLocked) { Runtime.trap("risk config is permanently locked") };
        riskConfig := p.value;
        pendingRiskConfig := null;
      };
    };
  };

  // Irreversibly disables proposeRiskConfig -- same "promise becomes code,
  // not a key" step as mother's lockIcpFeeTarget/lockCyclesFundRatio.
  public shared ({ caller }) func lockRiskConfig() : async () {
    requireController(caller);
    riskConfigLocked := true;
    pendingRiskConfig := null;
  };

  // Lets the controller reclaim seeded bankroll -- timelocked and
  // lockable, deliberately the only way ICP/PIKO ever leaves this canister
  // other than a player payout or the capped cycles sweep below, so a
  // compromised controller key can't snap-drain the bankroll players are
  // betting against.
  public shared ({ caller }) func proposeWithdrawal(token : Types.TokenKind, to : Principal, amount : Nat) : async () {
    requireController(caller);
    if (withdrawalsLocked) { Runtime.trap("withdrawals are permanently locked") };
    pendingWithdrawal := ?{ token; to; amount; readyAt = Time.now() + ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func cancelPendingWithdrawal() : async () {
    requireController(caller);
    pendingWithdrawal := null;
  };

  public shared func executeWithdrawal() : async Types.TransferResult {
    switch (pendingWithdrawal) {
      case null { Runtime.trap("no pending withdrawal") };
      case (?p) {
        if (Time.now() < p.readyAt) { Runtime.trap("timelock has not elapsed yet") };
        if (withdrawalsLocked) { Runtime.trap("withdrawals are permanently locked") };
        pendingWithdrawal := null;
        let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerIdFor(p.token)));
        await Ledger.icrc1_transfer({
          from_subaccount = null;
          to = { owner = p.to; subaccount = null };
          amount = p.amount;
          fee = null;
          memo = null;
          created_at_time = null;
        });
      };
    };
  };

  // Irreversibly disables proposeWithdrawal -- meant to be called once the
  // controller is confident the bankroll should only ever grow from here,
  // the step right before blackholing this canister for good.
  public shared ({ caller }) func lockWithdrawals() : async () {
    requireController(caller);
    withdrawalsLocked := true;
    pendingWithdrawal := null;
  };

  // ---- Profit sweep (ICP surplus -> cycles), same shape as mother's sweepTreasury ----
  // Only ever touches ICP above icpBankrollFloorE8s -- the floor is what's
  // actually at risk against player payouts, so it's never eligible to fund
  // cycles. PIKO profit is deliberately left alone: the CMC only converts
  // ICP, and letting PIKO profit simply accumulate as bankroll (rather than
  // trying to route it anywhere) is what lets bet sizes on PIKO grow over
  // time as the game gets used -- exactly the "give PIKO something to do"
  // goal this canister exists for.
  func principalToSubaccount(p : Principal) : Blob {
    let bytes = Blob.toArray(Principal.toBlob(p));
    let len = bytes.size();
    Blob.fromArray(
      Array.tabulate<Nat8>(
        32,
        func(i) {
          if (i == 0) { Nat8.fromNat(len) } else if (i <= len) { bytes[i - 1] } else { 0 };
        },
      )
    );
  };

  let MEMO_TOP_UP_CANISTER : Blob = Blob.fromArray([0x54, 0x50, 0x55, 0x50, 0, 0, 0, 0]);

  public shared func sweepIcpProfit() : async Types.SweepResult {
    let IcpLedger : Types.LedgerActor = actor (Principal.toText(icpLedgerId));
    let self_ = Principal.fromActor(self);
    let balance = await IcpLedger.icrc1_balance_of({ owner = self_; subaccount = null });
    let floor = riskConfig.icpBankrollFloorE8s + ICP_LEDGER_FEE_E8S;
    if (balance <= floor) {
      return { profit = 0; cyclesFunded = 0; cyclesMinted = null; notifyError = null };
    };

    let profit = balance - floor;
    let cyclesAmount = profit * riskConfig.cyclesFundRatioBps / 10_000;
    if (cyclesAmount == 0) {
      return { profit; cyclesFunded = 0; cyclesMinted = null; notifyError = null };
    };

    var cyclesMinted : ?Nat = null;
    var notifyError : ?Text = null;
    let transferOutcome = try {
      ?(
        await IcpLedger.icrc1_transfer({
          from_subaccount = null;
          to = { owner = cmcId; subaccount = ?principalToSubaccount(self_) };
          amount = cyclesAmount;
          fee = null;
          memo = ?MEMO_TOP_UP_CANISTER;
          created_at_time = null;
        })
      );
    } catch (_e) { null };

    switch (transferOutcome) {
      case (? #Ok(blockIndex)) {
        let Cmc : Types.CmcActor = actor (Principal.toText(cmcId));
        let notifyOutcome = try {
          ?(await Cmc.notify_top_up({ block_index = Nat64.fromNat(blockIndex); canister_id = self_ }));
        } catch (_e) { null };
        switch (notifyOutcome) {
          case (? #Ok(cycles)) { cyclesMinted := ?cycles };
          case (? #Err(e)) { notifyError := ?debug_show (e) };
          case null { notifyError := ?"notify_top_up call failed" };
        };
      };
      case (? #Err(e)) { notifyError := ?debug_show (e) };
      case null { notifyError := ?"icrc1_transfer to CMC failed" };
    };

    { profit; cyclesFunded = cyclesAmount; cyclesMinted; notifyError };
  };

  func armSweepTimer<system>() {
    switch (sweepTimerId) {
      case (?id) { Timer.cancelTimer(id) };
      case null {};
    };
    sweepTimerId := ?Timer.recurringTimer<system>(
      #seconds SWEEP_INTERVAL_SECONDS,
      func() : async () { ignore (await sweepIcpProfit()) },
    );
  };

  system func postupgrade() { armSweepTimer<system>() };

  armSweepTimer<system>();
};
