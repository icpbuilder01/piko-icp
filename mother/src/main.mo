import Principal "mo:core/Principal";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Iter "mo:core/Iter";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Array "mo:core/Array";
import Time "mo:core/Time";
import Text "mo:core/Text";
import Cycles "mo:core/Cycles";
import Runtime "mo:core/Runtime";
import Timer "mo:core/Timer";
import Map "mo:core/Map";
import Sha256 "mo:sha2/Sha256";
import Types "types";

// PIKO "mother node": coordinates a simulated proof-of-on-chain-work mining
// game, inspired by the publicly described mechanics of bob.fun, but an
// independent project under its own name/token -- see README for the
// non-affiliation notice.
actor self {

  // ---- Tokenomics constants (mirrors the spec the user described) ----
  let DECIMALS_FACTOR : Nat = 100_000_000; // 8 decimals, like the ICP ledger
  let MAX_SUPPLY : Nat = 21_000_000 * DECIMALS_FACTOR;
  let INITIAL_REWARD : Nat = 600 * DECIMALS_FACTOR;
  let HALVING_INTERVAL : Nat = 17_500;

  // Anti-spam: minimum time between submitProof calls from the same
  // principal. Ordinary IC ingress calls (e.g. from a browser, via Internet
  // Identity) cannot attach cycles -- only canister-to-canister calls can --
  // so this can't be a cycles fee like a canister miner could pay; any
  // cycles a canister miner *does* attach are still accepted opportunistically.
  let MIN_SUBMIT_INTERVAL_NANOS : Int = 300_000_000; // 0.3s

  let MAX_RECENT_BLOCKS : Nat = 20;

  // ---- Ledger wiring ----
  // The `ledger` canister's principal is injected by icp-cli at deploy time
  // (see "Canister Discovery" in the icp-cli docs) and read once here, since
  // this initializer only runs on first install under enhanced orthogonal
  // persistence (--default-persistent-actors).
  let ledgerId : Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:ledger")) {
    case (?text) { Principal.fromText(text) };
    case null {
      Runtime.trap("PUBLIC_CANISTER_ID:ledger is not set -- deploy the `ledger` canister first");
    };
  };
  let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerId));

  // frontend/miner (the reference instance) don't have their own way to
  // earn cycles -- unlike mother, which self-funds via sweepTreasury below,
  // they've relied entirely on manual `icp canister top-up`. Optional
  // (not trapping if unset) since, unlike ledger, mother can run fine
  // without knowing about either -- topUpProject() below just does nothing
  // for whichever one isn't configured.
  let frontendId : ?Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:frontend")) {
    case (?text) { ?Principal.fromText(text) };
    case null { null };
  };
  let referenceMinerId : ?Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:miner")) {
    case (?text) { ?Principal.fromText(text) };
    case null { null };
  };

  // The ICP ledger used to charge (and burn) the mining fee, and the
  // account transfers to it are burned to. Defaults to the real mainnet ICP
  // ledger (ryjl3-tyaaa-aaaaa-aaaba-cai) and its real minting account
  // (rrkah-fqaaa-aaaaa-aaaaq-cai, verified live via `icrc1_minting_account`
  // before wiring this in) -- `var`, not `let`, so it can be pointed at a
  // local test ICRC ledger while verifying this logic locally, since the
  // real ICP ledger only exists on mainnet. See setIcpFeeTarget().
  var icpLedgerId : Principal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  var icpBurnOwner : Principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  // Cycles Minting Canister: converts a share of the swept ICP into cycles
  // for this canister's own upkeep instead of burning it (see
  // sweepTreasury() below). Defaults to the real mainnet CMC; `var` for the
  // same local-testing reason as icpLedgerId/icpBurnOwner above, and gated
  // by the same icpFeeTargetLocked flag.
  var cmcId : Principal = Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai");
  // Once true, setIcpFeeTarget is permanently disabled (see lockIcpFeeTarget
  // below). Until this is locked, the controller could redirect the burn
  // destination (or the CMC) with a single call -- no code upgrade needed --
  // so this is disclosed in getStats() and meant to be locked shortly after
  // launch, once local-testing needs are done.
  var icpFeeTargetLocked : Bool = false;

  // Share of each sweepTreasury() balance that's converted to cycles instead
  // of burned, in basis points (2000 = 20%); the rest is burned exactly as
  // every block's fee always was. Timelocked and lockable exactly like
  // icpBurnOwner (see proposeCyclesFundRatioBps/lockCyclesFundRatio below)
  // -- a ratio the controller could change without notice would make the
  // "X% is burned" claim just as unreliable as an unlocked burn address,
  // even though it can never redirect funds off-protocol.
  var cyclesFundRatioBps : Nat = 2000;
  var cyclesFundRatioLocked : Bool = false;
  // The ICP ledger's own transfer fee (0.0001 ICP), needed to size
  // sweepTreasury()'s two outgoing transfers. This is the ICP ledger's fee,
  // not PIKO's own ledger fee (set separately in icrc1_ledger_init.args) --
  // the two happen to share the same value today, but are unrelated.
  let ICP_LEDGER_FEE_E8S : Nat = 10_000;
  // How often sweepTreasury() runs automatically (see armSweepTimer below).
  // Keeps the ICP balance sitting in this canister's own account -- the
  // "treasury" between fee collection and the actual burn/cycles-conversion
  // -- small at any given moment, rather than depending on a keeper/cron to
  // remember to call sweepTreasury() manually. Manual calls still work too
  // (e.g. to sweep immediately rather than waiting for the next tick).
  let SWEEP_INTERVAL_SECONDS : Nat = 3600; // 1h
  transient var sweepTimerId : ?Timer.TimerId = null;

  // Never share cycles below this floor -- mother keeps whatever it needs
  // for its own healthy operation first, and only forwards genuine
  // surplus. See topUpProject() below.
  let CYCLES_RESERVE : Nat = 2_000_000_000_000; // 2T

  // ---- Mining state ----
  // Genesis header: a fixed, reproducible seed (not a real value, just a
  // deterministic starting point for the chain of headers).
  var previousHash : Blob = Sha256.fromArray(
    #sha256,
    Blob.toArray(
      Text.encodeUtf8("PIKO genesis -- independent project, not affiliated with bob.fun/BOB")
    ),
  );
  var height : Nat = 0;
  // Leading zero bits required in sha256(previousHash # height # nonce).
  // 18 bits: measured against the real per-attempt cost of the browser
  // miner's search loop (miner.worker.ts does one `await
  // crypto.subtle.digest` per nonce, no batching -- roughly 20-30k
  // attempts/sec single-tab, benchmarked directly rather than guessed),
  // this targets on the order of single-digit seconds to a first block for
  // one solo miner: fast enough to feel rewarding immediately, not so fast
  // it stops looking like real work. (An earlier 22-bit starting point,
  // picked before any real hashrate data existed, averaged well over a
  // minute solo -- technically not a bug, just a bad first impression.)
  // From here on it's retargeted automatically (see "Automatic difficulty
  // retargeting" below) as real, possibly-much-higher combined
  // participation shows up -- never hand-set again.
  var difficultyBits : Nat = 18;
  // Total reward reserved against MAX_SUPPLY -- incremented the instant a
  // block's reward is decided (in submitProof, right when height advances),
  // *not* when the ICRC transfer to the miner actually succeeds. A reward
  // that only made it as far as pendingRewards (transfer failed, to be
  // retried via claimPendingReward()) still counts here. This is what keeps
  // the 21,000,000 cap real even during a sustained ledger outage: without
  // it, every block minted while transfers are failing would be clamped
  // against a totalMinted that never moved, letting the eventual sum of
  // claimed pendingRewards land past the cap once the ledger recovers.
  var totalMinted : Nat = 0;
  // ICP burned (sent to the ICP ledger's minting account) per accepted
  // block, in e8s. Default 0.05 ICP -- kept deliberately low during the
  // adoption phase (see README) so the entry cost doesn't fight the
  // "mine right in your browser, no friction" pitch; adjustable via
  // setMiningFeeE8s() as real demand data comes in.
  var miningFeeE8s : Nat = 5_000_000;

  // Cumulative ICP (e8s) actually burned to icpBurnOwner, across every
  // sweepTreasury() call ever made -- incremented only once a burn
  // transfer is confirmed #Ok, never for an attempt that failed or
  // traps (that ICP just stays in this canister's balance for the next
  // sweep to retry, uncounted until it really leaves). The running
  // public answer to "how much real ICP has mining PIKO destroyed so
  // far" -- see getStats().
  var totalIcpBurned : Nat = 0;

  var recentBlocks : [Types.Block] = [];
  // Persisted, not transient: this is real, specific PIKO owed to specific
  // miners (a block was accepted, its mint just hasn't landed yet). Making
  // this `transient` -- as an earlier version of this file did -- means it
  // resets to empty on every canister upgrade, silently destroying any
  // unclaimed reward with no trap and no error. lastAttempt below is the
  // opposite case: it's fine (even desirable) for it to reset on upgrade,
  // since it owes nothing to anyone.
  let pendingRewards : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
  transient let lastAttempt : Map.Map<Principal, Time.Time> = Map.empty<Principal, Time.Time>();

  // Cumulative per-miner stats (leaderboard). Persisted (not transient) so
  // it survives upgrades -- unlike the other maps above, this is meant to be
  // a durable record, not just in-flight bookkeeping.
  let minerBlocks : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
  let minerRewards : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();

  // ---- Helpers ----

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

  func computeHash(prev : Blob, atHeight : Nat, nonce : Nat) : Blob {
    let bytes = Array.concat(
      Array.concat(Blob.toArray(prev), natToBytes8(atHeight)),
      natToBytes8(nonce),
    );
    Sha256.fromArray(#sha256, bytes);
  };

  func rewardForHeight(atHeight : Nat) : Nat {
    let halvings = atHeight / HALVING_INTERVAL;
    if (halvings >= 40) { 0 } else { INITIAL_REWARD / (2 ** halvings) };
  };

  func clampToSupplyCap(nominal : Nat) : Nat {
    let remaining = if (MAX_SUPPLY > totalMinted) { MAX_SUPPLY - totalMinted } else {
      0;
    };
    if (nominal > remaining) { remaining } else { nominal };
  };

  // ---- Automatic difficulty retargeting ----
  // Bitcoin-style: difficulty adjusts itself from on-chain block
  // timestamps only, with no controller call in the loop. This is what
  // lets `mother` be safely blackholed later (see README's roadmap) --
  // a hand-picked difficultyBits that could never be revisited again
  // would either stall the chain (too hard for real participation) or
  // blow through the supply cap in days (too easy), and there would be
  // no way to fix either outcome once no controller remains.
  //
  // 5 minutes is the steady-state target once real participation is
  // underway -- the 18-bit starting point above is deliberately tuned for
  // a fast first block instead, and retargeting is what carries difficulty
  // from that low starting point up to wherever real combined hashrate
  // actually puts a 5-minute block, automatically, instead of requiring
  // someone to notice and call setDifficulty() by hand.
  let TARGET_BLOCK_TIME_NANOS : Nat = 5 * 60 * 1_000_000_000; // 5 minutes
  // Short window (10 blocks) rather than bitcoin's ~2016: PIKO is early
  // and low-height, so reacting quickly to real participation matters
  // more than smoothing out noise over a long window.
  let RETARGET_INTERVAL_BLOCKS : Nat = 10;
  let RETARGET_TARGET_WINDOW_NANOS : Nat = RETARGET_INTERVAL_BLOCKS * TARGET_BLOCK_TIME_NANOS;
  // Caps how far one retarget can move difficulty, mirroring bitcoin's
  // classic 4x-per-adjustment clamp (2 bits = 4x more/less expected
  // work per proof). Keeps one unusually fast or slow 10-block window --
  // easy to get with only a handful of miners -- from swinging
  // difficulty wildly on a small sample.
  let MAX_RETARGET_STEP_BITS : Nat = 2;
  let MIN_DIFFICULTY_BITS : Nat = 1;
  let MAX_DIFFICULTY_BITS : Nat = 256;

  // When the current retarget window started: the wall-clock time and
  // chain height right after the previous retarget (or genesis, for the
  // very first window). `var`, not `transient var` -- this is a real
  // fact about the chain's history, not in-flight bookkeeping, so it
  // must survive upgrades exactly like previousHash/height do.
  var retargetAnchorTime : Time.Time = Time.now();
  var retargetAnchorHeight : Nat = 0;
  var lastRetargetAt : Time.Time = retargetAnchorTime;

  // floor(log2(numerator / denominator)), clamped to [0, cap]. Integer-only
  // (no Float) so this is trivially reproducible and auditable: it just
  // doubles `denominator` at most `cap` times rather than doing real
  // division/log math, which is all the small, bounded cap here needs.
  func log2FloorClamped(numerator : Nat, denominator : Nat, cap : Nat) : Nat {
    if (denominator == 0 or numerator <= denominator) { return 0 };
    var scaled = denominator;
    var steps = 0;
    while (steps < cap and scaled * 2 <= numerator) {
      scaled *= 2;
      steps += 1;
    };
    steps;
  };

  // Applies one retarget step based on how long the just-completed window
  // actually took vs. RETARGET_TARGET_WINDOW_NANOS, then rolls the window
  // forward. Called from submitProof right after height advances, only
  // once a full window has elapsed -- so as long as blocks keep getting
  // found (by anyone), difficulty keeps tracking real block times on its
  // own, with no external caller or keeper required.
  func maybeRetarget(now : Time.Time) {
    if (height < retargetAnchorHeight + RETARGET_INTERVAL_BLOCKS) { return };

    let elapsed = now - retargetAnchorTime; // Int, expected positive
    // Guards a clock/anchor anomaly (elapsed <= 0) by treating the window
    // as having taken ~0 time -- reads as "extremely fast", which clamps
    // to the same MAX_RETARGET_STEP_BITS increase as any other fast
    // window, rather than trapping or under/overflowing a Nat conversion.
    let actualNanos = if (elapsed > 0) { Int.toNat(elapsed) } else { 1 };

    let newBits = if (actualNanos < RETARGET_TARGET_WINDOW_NANOS) {
      // blocks came faster than target -> harder
      let steps = log2FloorClamped(RETARGET_TARGET_WINDOW_NANOS, actualNanos, MAX_RETARGET_STEP_BITS);
      Nat.min(difficultyBits + steps, MAX_DIFFICULTY_BITS);
    } else if (actualNanos > RETARGET_TARGET_WINDOW_NANOS) {
      // blocks came slower than target -> easier
      let steps = log2FloorClamped(actualNanos, RETARGET_TARGET_WINDOW_NANOS, MAX_RETARGET_STEP_BITS);
      if (steps >= difficultyBits) { MIN_DIFFICULTY_BITS } else {
        Nat.max(difficultyBits - steps, MIN_DIFFICULTY_BITS);
      };
    } else { difficultyBits };

    difficultyBits := newBits;
    retargetAnchorHeight := height;
    retargetAnchorTime := now;
    lastRetargetAt := now;
  };

  func pushRecentBlock(b : Types.Block) {
    let combined = Array.concat(recentBlocks, [b]);
    let n = combined.size();
    recentBlocks := if (n > MAX_RECENT_BLOCKS) {
      Array.tabulate<Types.Block>(
        MAX_RECENT_BLOCKS,
        func(i) { combined[n - MAX_RECENT_BLOCKS + i] },
      );
    } else { combined };
  };

  func addPendingReward(p : Principal, amount : Nat) {
    let current = switch (Map.get(pendingRewards, Principal.compare, p)) {
      case (?v) { v };
      case null { 0 };
    };
    Map.add(pendingRewards, Principal.compare, p, current + amount);
  };

  func recordMinerStats(p : Principal, reward : Nat) {
    let blocks = switch (Map.get(minerBlocks, Principal.compare, p)) {
      case (?v) { v };
      case null { 0 };
    };
    Map.add(minerBlocks, Principal.compare, p, blocks + 1);
    let rewards = switch (Map.get(minerRewards, Principal.compare, p)) {
      case (?v) { v };
      case null { 0 };
    };
    Map.add(minerRewards, Principal.compare, p, rewards + reward);
  };

  // Mints `amount` to `to` by transferring from the ledger's minting account
  // (this canister). If the transfer fails or traps, the amount is recorded
  // as a pending reward the miner can retry via claimPendingReward() --
  // state (recentBlocks/height) has already advanced by this point, so a
  // failed mint never blocks the chain, it just needs a retry. totalMinted
  // is *not* touched here -- it was already incremented by the caller
  // (submitProof) the moment this reward was decided, precisely so the
  // supply cap doesn't depend on this transfer's success; see totalMinted's
  // own comment above.
  func payReward(to : Principal, amount : Nat) : async () {
    let outcome = try {
      ?(
        await Ledger.icrc1_transfer({
          from_subaccount = null;
          to = { owner = to; subaccount = null };
          amount = amount;
          fee = null;
          memo = null;
          created_at_time = null;
        })
      );
    } catch (_e) { null };

    switch (outcome) {
      case (? #Ok(_)) {};
      case (_) { addPendingReward(to, amount) };
    };
  };

  // ---- Public API ----

  public query func getWork() : async Types.Work {
    {
      height;
      previousHash;
      difficultyBits;
      reward = clampToSupplyCap(rewardForHeight(height));
      miningFeeE8s;
    };
  };

  public query func getStats() : async Types.Stats {
    {
      height;
      totalMinted;
      maxSupply = MAX_SUPPLY;
      difficultyBits;
      currentReward = clampToSupplyCap(rewardForHeight(height));
      nextHalvingHeight = (height / HALVING_INTERVAL + 1) * HALVING_INTERVAL;
      ledgerId;
      miningFeeE8s;
      icpLedgerId;
      icpBurnOwner;
      icpFeeTargetLocked;
      cmcId;
      cyclesFundRatioBps;
      cyclesFundRatioLocked;
      retargetIntervalBlocks = RETARGET_INTERVAL_BLOCKS;
      targetBlockTimeNanos = TARGET_BLOCK_TIME_NANOS;
      blocksUntilRetarget = retargetAnchorHeight + RETARGET_INTERVAL_BLOCKS - height;
      lastRetargetAt;
      totalIcpBurnedE8s = totalIcpBurned;
    };
  };

  public query func getRecentBlocks() : async [Types.Block] {
    recentBlocks;
  };

  public query ({ caller }) func getPendingReward() : async Nat {
    switch (Map.get(pendingRewards, Principal.compare, caller)) {
      case (?v) { v };
      case null { 0 };
    };
  };

  // Sum of every miner's unclaimed pending reward. Mainly useful before an
  // upgrade: pendingRewards is real PIKO owed to specific miners, so this is
  // a quick way to check "is there anything at stake right now" without
  // having to ask every miner to call getPendingReward() individually.
  public query func getTotalPendingRewards() : async Nat {
    var total = 0;
    for ((_, v) in Map.entries(pendingRewards)) { total += v };
    total;
  };

  public query func cyclesBalance() : async Nat {
    Cycles.balance();
  };

  // Verifies sha256(previousHash # height # nonce) server-side (never trusts
  // a client-supplied hash), pulls the ICP mining fee from the caller (they
  // must have called icrc2_approve on the ICP ledger beforehand) into this
  // canister's own ICP balance, then advances the chain and mints the
  // reward. The fee is burned (and partly converted to cycles) later, in
  // batches -- see sweepTreasury() below -- rather than on every single
  // submission, so one block's fee doesn't pay a second ICP ledger transfer
  // fee just to be swept back out immediately.
  //
  // This is pay-to-play, not play-to-win: the fee leaves the caller's
  // control the moment a valid proof is submitted, whether or not this
  // submission goes on to win the block, and is never refunded from that
  // point on -- same as real proof-of-work, where compute spent on a block
  // someone else found first is never reimbursed. That real, unrefunded
  // cost is what makes mining an actual competition instead of a free-roll;
  // see README.
  //
  // Ordering: cheap local checks first (anonymity, rate limit, hash
  // validity), then the costly inter-canister fee pull, then a freshness
  // re-check (another submission could have advanced the chain while we
  // were awaiting the fee pull) purely to protect correctness -- so this
  // (now-paid) submission can never mutate state or mint a second reward for
  // a height that already has a winner.
  public shared ({ caller }) func submitProof<system>(nonce : Nat) : async Types.SubmitResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };

    let now = Time.now();
    switch (Map.get(lastAttempt, Principal.compare, caller)) {
      case (?last) {
        let elapsed = now - last; // Int: Time.Time is nanoseconds since epoch
        let remaining = MIN_SUBMIT_INTERVAL_NANOS - elapsed;
        if (remaining > 0) {
          return #Err(#TooSoon({ retryAfterNanos = Int.toNat(remaining) }));
        };
      };
      case null {};
    };
    Map.add(lastAttempt, Principal.compare, caller, now);

    // Opportunistic: canister miners may attach cycles to help fund this
    // canister, but it's never required -- browser callers can't attach any.
    ignore Cycles.accept<system>(Cycles.available());

    let submittedHeight = height;
    let candidateHash = computeHash(previousHash, submittedHeight, nonce);
    if (leadingZeroBits(candidateHash) < difficultyBits) {
      return #Err(#InvalidProof);
    };

    if (miningFeeE8s > 0) {
      let IcpLedger : Types.IcpLedgerActor = actor (Principal.toText(icpLedgerId));
      let feeOutcome = try {
        ?(
          await IcpLedger.icrc2_transfer_from({
            spender_subaccount = null;
            from = { owner = caller; subaccount = null };
            to = { owner = Principal.fromActor(self); subaccount = null };
            amount = miningFeeE8s;
            fee = null;
            memo = null;
            created_at_time = null;
          })
        );
      } catch (_e) { null };

      switch (feeOutcome) {
        case (? #Ok(_)) {};
        case (? #Err(e)) { return #Err(#IcpFeeFailed(e)) };
        case null {
          return #Err(#IcpFeeFailed(#TemporarilyUnavailable));
        };
      };
    };

    // Re-check freshness: another submission may have advanced the chain
    // while we were awaiting the fee burn above. If so, this one lost the
    // race. Its fee stays burned regardless -- see the comment above this
    // function for why that's intentional.
    if (height != submittedHeight) {
      return #Err(#StaleWork);
    };

    let reward = clampToSupplyCap(rewardForHeight(submittedHeight));
    let confirmedNow = Time.now();

    height += 1;
    previousHash := candidateHash;
    pushRecentBlock({
      height = submittedHeight;
      miner = caller;
      reward;
      hash = candidateHash;
      timestamp = confirmedNow;
    });
    recordMinerStats(caller, reward);
    totalMinted += reward; // reserve against the cap now, regardless of whether the transfer below succeeds
    maybeRetarget(confirmedNow);

    if (reward > 0) {
      await payReward(caller, reward);
    };

    #Ok({ height = submittedHeight; reward; hash = candidateHash });
  };

  public query func getLeaderboard() : async [Types.LeaderboardEntry] {
    let entries = Array.map<(Principal, Nat), Types.LeaderboardEntry>(
      Iter.toArray(Map.entries(minerBlocks)),
      func((p, blocks)) {
        let reward = switch (Map.get(minerRewards, Principal.compare, p)) {
          case (?v) { v };
          case null { 0 };
        };
        { miner = p; blocksFound = blocks; totalReward = reward };
      },
    );
    let sorted = Array.sort<Types.LeaderboardEntry>(
      entries,
      func(a, b) { Nat.compare(b.totalReward, a.totalReward) },
    );
    if (sorted.size() > 10) {
      Array.tabulate<Types.LeaderboardEntry>(10, func(i) { sorted[i] });
    } else { sorted };
  };

  public shared ({ caller }) func claimPendingReward<system>() : async Types.SubmitResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    let owed = switch (Map.get(pendingRewards, Principal.compare, caller)) {
      case (?v) { v };
      case null { 0 };
    };
    if (owed == 0) { return #Err(#NothingToClaim) };

    // clear before await, so a second concurrent claim call can't double-pay
    Map.remove(pendingRewards, Principal.compare, caller);
    await payReward(caller, owed);
    #Ok({ height; reward = owed; hash = previousHash });
  };

  // ---- Admin (controller-only) ----

  func requireController(caller : Principal) {
    if (not Principal.isController(caller)) {
      Runtime.trap("only a controller can call this");
    };
  };

  // Anything that could hurt miners/holders in a single call -- redirecting
  // where the ICP fee target points, or moving the burn/cycles split --
  // goes through propose-now/execute-after-a-delay instead of taking effect
  // immediately. A compromised or careless controller key can no longer
  // redirect funds in one transaction: the change sits in
  // getPendingAdminChanges() for the full delay before it can land, giving
  // miners/holders a window to notice and react (or the real controller a
  // window to call the matching cancelPending*()). Difficulty itself no
  // longer has a controller path at all -- see "Automatic difficulty
  // retargeting" above -- so there's nothing to propose or timelock there
  // anymore.
  //
  // The delay is a hardcoded constant, not a controller-settable var -- a
  // setter for it would let a compromised key shorten it to zero right
  // before pushing a malicious change, defeating the entire point.
  let ADMIN_TIMELOCK_NANOS : Int = 48 * 60 * 60 * 1_000_000_000; // 48h

  // Dead field, kept on purpose: difficulty no longer has a propose/execute
  // path (see "Automatic difficulty retargeting" above), but this project's
  // own upgrade rule (README's "Upgrading mother or miner safely") is that a
  // deployed top-level `var` can never be removed without tripping
  // `RTS error: Memory-incompatible program upgrade` on the next upgrade --
  // only ever add declarations. Removing this one would trap upgrading the
  // already-deployed mainnet `mother`. Permanently null; nothing reads or
  // writes it anymore.
  var pendingDifficulty : ?Types.PendingNatChange = null;

  var pendingCyclesFundRatio : ?Types.PendingNatChange = null;
  var pendingIcpFeeTarget : ?Types.PendingIcpFeeTarget = null;

  public query func getPendingAdminChanges() : async Types.PendingAdminChanges {
    {
      cyclesFundRatio = pendingCyclesFundRatio;
      icpFeeTarget = pendingIcpFeeTarget;
      timelockNanos = ADMIN_TIMELOCK_NANOS;
    };
  };

  // Not timelocked: unlike the ICP fee target, this can only
  // ever make mining cheaper or more expensive for everyone equally -- it
  // can't drain remaining supply (rewardForHeight doesn't depend on it) or
  // redirect funds anywhere. Lower blast radius than the two above.
  public shared ({ caller }) func setMiningFeeE8s(e8s : Nat) : async () {
    requireController(caller);
    miningFeeE8s := e8s;
  };

  // Only meant for pointing this canister at a local test ICRC ledger (and
  // test CMC) while verifying the fee-burn/cycles-funding logic (the real
  // ICP ledger and CMC only exist on mainnet). Timelocked like
  // proposeDifficulty above, and permanently disabled once
  // lockIcpFeeTarget() has been called.
  public shared ({ caller }) func proposeIcpFeeTarget(ledgerId : Principal, burnOwner : Principal, cyclesMintingCanister : Principal) : async () {
    requireController(caller);
    if (icpFeeTargetLocked) {
      Runtime.trap("the ICP fee target is permanently locked");
    };
    pendingIcpFeeTarget := ?{
      ledgerId;
      burnOwner;
      cmcId = cyclesMintingCanister;
      readyAt = Time.now() + ADMIN_TIMELOCK_NANOS;
    };
  };

  public shared ({ caller }) func cancelPendingIcpFeeTarget() : async () {
    requireController(caller);
    pendingIcpFeeTarget := null;
  };

  public shared func executeIcpFeeTarget() : async () {
    switch (pendingIcpFeeTarget) {
      case null { Runtime.trap("no pending ICP fee target change") };
      case (?p) {
        if (Time.now() < p.readyAt) {
          Runtime.trap("timelock has not elapsed yet");
        };
        if (icpFeeTargetLocked) {
          Runtime.trap("the ICP fee target is permanently locked");
        };
        icpLedgerId := p.ledgerId;
        icpBurnOwner := p.burnOwner;
        cmcId := p.cmcId;
        pendingIcpFeeTarget := null;
      };
    };
  };

  // Irreversibly disables proposeIcpFeeTarget, so the burn destination (and
  // which ICP ledger/CMC is used) can never change again without a full code
  // upgrade -- meant to be called once local-testing needs are done, so the
  // controller can no longer redirect the burn even via the timelocked path.
  public shared ({ caller }) func lockIcpFeeTarget() : async () {
    requireController(caller);
    icpFeeTargetLocked := true;
    pendingIcpFeeTarget := null;
  };

  // Controls sweepTreasury()'s burn/cycles-funding split. Timelocked and
  // lockable exactly like the ICP fee target -- it can never redirect funds
  // off-protocol, but an instantly-changeable ratio would make "X% of every
  // fee is burned" just as unreliable a promise as an unlocked burn address,
  // so it gets the same treatment.
  public shared ({ caller }) func proposeCyclesFundRatioBps(bps : Nat) : async () {
    requireController(caller);
    if (cyclesFundRatioLocked) {
      Runtime.trap("the cycles-fund ratio is permanently locked");
    };
    if (bps > 10_000) {
      Runtime.trap("cyclesFundRatioBps must be <= 10000 (100%)");
    };
    pendingCyclesFundRatio := ?{ value = bps; readyAt = Time.now() + ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func cancelPendingCyclesFundRatio() : async () {
    requireController(caller);
    pendingCyclesFundRatio := null;
  };

  public shared func executeCyclesFundRatioBps() : async () {
    switch (pendingCyclesFundRatio) {
      case null { Runtime.trap("no pending cycles-fund ratio change") };
      case (?p) {
        if (Time.now() < p.readyAt) {
          Runtime.trap("timelock has not elapsed yet");
        };
        if (cyclesFundRatioLocked) {
          Runtime.trap("the cycles-fund ratio is permanently locked");
        };
        cyclesFundRatioBps := p.value;
        pendingCyclesFundRatio := null;
      };
    };
  };

  // Irreversibly disables proposeCyclesFundRatioBps, so the burn/cycles
  // split can never change again without a full code upgrade -- the same
  // "the promise is now code, not a key" step as lockIcpFeeTarget.
  public shared ({ caller }) func lockCyclesFundRatio() : async () {
    requireController(caller);
    cyclesFundRatioLocked := true;
    pendingCyclesFundRatio := null;
  };

  // ---- Maintenance ----
  // lastAttempt is transient and unbounded: any freshly-generated principal
  // can add an entry for free, even with an invalid proof (see README's
  // "unbounded lastAttempt growth" disclosure and the security audit).
  // Nothing here prevents that -- no per-call cost can be added without also
  // blocking legitimate anonymous browser miners -- but it bounds the
  // damage: an entry older than MIN_SUBMIT_INTERVAL_NANOS is provably stale
  // (that principal's cooldown has already expired) and safe to drop.
  // Permissionless, like sweepTreasury() -- meant to be called periodically
  // by a keeper/cron rather than relying on any single party.
  public shared func pruneStaleAttempts() : async Nat {
    let now = Time.now();
    let entries = Iter.toArray(Map.entries(lastAttempt));
    let stale = Array.filter<(Principal, Time.Time)>(
      entries,
      func((_, t)) { now - t > MIN_SUBMIT_INTERVAL_NANOS },
    );
    for ((p, _) in stale.vals()) {
      Map.remove(lastAttempt, Principal.compare, p);
    };
    stale.size();
  };

  // ---- Treasury sweep (ICP -> burn + cycles) ----
  // submitProof() above pulls the mining fee into this canister's own ICP
  // balance rather than burning it immediately, to avoid paying the ICP
  // ledger's transfer fee twice per block. This function is where that
  // balance actually gets spent: it splits whatever ICP is on hand right
  // now between a burn (to icpBurnOwner, exactly as every block's fee always
  // was) and a conversion to cycles via the CMC, funding this canister's own
  // upkeep instead of relying solely on manual `icp cycles top-up`.
  //
  // Deliberately stateless: every call re-reads this canister's actual ICP
  // balance rather than tracking a running total, so a failed leg (a
  // transfer that traps, or a notify_top_up that comes back #Err) simply
  // leaves its share of the balance in place for the next call to retry --
  // there's no separate counter here that could ever drift out of sync with
  // what's really in this canister's account (contrast with pendingRewards,
  // which does need bookkeeping because it owes specific amounts to specific
  // miners; this owes nothing to anyone).
  //
  // Permissionless by design, like miner's deposit() -- anyone (a cron job,
  // a script, a curious miner) can trigger a sweep at any time. There's
  // nothing to gain by calling it other than paying its own cycles cost,
  // since it can only ever move this canister's ICP to the fixed burn
  // destination or into cycles for itself, never to a caller-chosen address.
  func principalToSubaccount(p : Principal) : Blob {
    let bytes = Blob.toArray(Principal.toBlob(p));
    let len = bytes.size();
    Blob.fromArray(
      Array.tabulate<Nat8>(
        32,
        func(i) {
          if (i == 0) { Nat8.fromNat(len) } else if (i <= len) {
            bytes[i - 1];
          } else { 0 };
        },
      )
    );
  };

  public shared func sweepTreasury() : async Types.SweepResult {
    let IcpLedger : Types.IcpLedgerActor = actor (Principal.toText(icpLedgerId));
    let self_ : Principal = Principal.fromActor(self);

    let balance = await IcpLedger.icrc1_balance_of({ owner = self_; subaccount = null });
    let feesNeeded = 2 * ICP_LEDGER_FEE_E8S; // one transfer for the burn leg, one for the CMC leg
    if (balance <= feesNeeded) {
      return { swept = 0; burned = 0; cyclesFunded = 0; cyclesMinted = null; notifyError = null };
    };

    let spendable = balance - feesNeeded;
    let cyclesAmount = spendable * cyclesFundRatioBps / 10_000;
    let burnAmount = spendable - cyclesAmount;

    if (burnAmount > 0) {
      let burnOutcome = try {
        ?(
          await IcpLedger.icrc1_transfer({
            from_subaccount = null;
            to = { owner = icpBurnOwner; subaccount = null };
            amount = burnAmount;
            fee = null;
            memo = null;
            created_at_time = null;
          })
        );
      } catch (_e) { null };
      switch (burnOutcome) {
        case (? #Ok(_)) { totalIcpBurned += burnAmount };
        case (_) {};
      };
    };

    var cyclesMinted : ?Nat = null;
    var notifyError : ?Text = null;
    if (cyclesAmount > 0) {
      let transferOutcome = try {
        ?(
          await IcpLedger.icrc1_transfer({
            from_subaccount = null;
            to = { owner = cmcId; subaccount = ?principalToSubaccount(self_) };
            amount = cyclesAmount;
            fee = null;
            memo = null;
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
    };

    { swept = spendable; burned = burnAmount; cyclesFunded = cyclesAmount; cyclesMinted; notifyError };
  };

  // Shares mother's own cycles surplus with frontend and the reference
  // miner -- neither has any way to earn cycles on its own, unlike mother
  // (which self-funds via sweepTreasury above), so both have depended
  // entirely on manual `icp canister top-up` since launch. mother is the
  // one canister whose running costs scale with mining activity in the
  // first place (via the cyclesFundRatioBps share of every fee), so
  // routing part of that back out to the two canisters that make mining
  // possible in the first place -- the site people mine from, and the
  // reference miner people can inspect -- closes the loop project-wide
  // instead of just for mother.
  //
  // Deliberately simple: keeps CYCLES_RESERVE for itself, splits whatever
  // is left 50/50 between the two (skipping either that isn't configured,
  // e.g. a deployment that never set PUBLIC_CANISTER_ID:frontend). No
  // state kept here either, for the same reason sweepTreasury keeps none:
  // it just re-reads Cycles.balance() fresh every call.
  public shared func topUpProject() : async { toFrontend : Nat; toMiner : Nat } {
    let balance = Cycles.balance();
    if (balance <= CYCLES_RESERVE) { return { toFrontend = 0; toMiner = 0 } };

    let targets = Array.filterMap<?Principal, Principal>(
      [frontendId, referenceMinerId],
      func(t) { t },
    );
    if (targets.size() == 0) { return { toFrontend = 0; toMiner = 0 } };

    let surplus = balance - CYCLES_RESERVE;
    let share = surplus / targets.size();
    let Management : Types.ManagementActor = actor (Principal.toText(Principal.fromText("aaaaa-aa")));

    var sentToFrontend = 0;
    var sentToMiner = 0;
    for (target in targets.vals()) {
      let _outcome = try {
        await (with cycles = share) Management.deposit_cycles({ canister_id = target });
        ?();
      } catch (_e) { null };
      switch (_outcome) {
        case (?()) {
          if (?target == frontendId) { sentToFrontend += share };
          if (?target == referenceMinerId) { sentToMiner += share };
        };
        case null {};
      };
    };
    { toFrontend = sentToFrontend; toMiner = sentToMiner };
  };

  // Fires sweepTreasury() then topUpProject() on a timer so neither depends
  // on an external keeper/cron remembering to call them: the ICP balance
  // sitting in this canister's own account never grows past roughly
  // SWEEP_INTERVAL_SECONDS worth of fees, and any cycles surplus gets
  // shared with frontend/miner on the same cadence. Errors inside either
  // are already swallowed internally (each leg just retries next time), so
  // nothing further to handle here.
  func armSweepTimer<system>() {
    switch (sweepTimerId) {
      case (?id) { Timer.cancelTimer(id) };
      case null {};
    };
    sweepTimerId := ?Timer.recurringTimer<system>(
      #seconds SWEEP_INTERVAL_SECONDS,
      func() : async () {
        ignore (await sweepTreasury());
        ignore (await topUpProject());
      },
    );
  };

  // Timers do not survive upgrades under enhanced orthogonal persistence
  // (same reason miner/src/main.mo re-arms its own timer here) -- and the
  // top-level armSweepTimer<system>() call below only runs on first install,
  // not on upgrade, so this is the only thing that re-arms it afterwards.
  system func postupgrade() {
    armSweepTimer<system>();
    // Re-anchor the retarget window to the canister's real current
    // height/time on every upgrade. Two reasons: (1) the first upgrade that
    // ever introduces retargetAnchorHeight/retargetAnchorTime as new
    // top-level vars runs their declared initializers (0 and the upgrade's
    // own Time.now()) rather than anything reflecting this canister's
    // actual, possibly-already-nonzero height -- without this, a canister
    // upgraded in mid-chain would measure a bogus first "window" from
    // height 0 instead of its real height, and fire an out-of-band retarget
    // on the very next block. (2) on every later upgrade too, this avoids
    // ever measuring a window that spans an upgrade's own (unrelated)
    // downtime as if it were real mining time. Harmless either way: at
    // worst this restarts the current window's clock, still bounded by the
    // same MAX_RETARGET_STEP_BITS clamp as any other retarget.
    retargetAnchorHeight := height;
    retargetAnchorTime := Time.now();
  };

  armSweepTimer<system>();
};
