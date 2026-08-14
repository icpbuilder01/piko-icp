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
  // 22 bits is a starting estimate for "a few minutes per block" at a small
  // number of concurrent miners (browser + canister); tune with
  // setDifficulty() once real traffic shows actual block times (see README).
  var difficultyBits : Nat = 22;
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
  // block, in e8s. Default 0.001 ICP -- adjustable via setMiningFeeE8s().
  var miningFeeE8s : Nat = 100_000;

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

    height += 1;
    previousHash := candidateHash;
    pushRecentBlock({
      height = submittedHeight;
      miner = caller;
      reward;
      hash = candidateHash;
      timestamp = Time.now();
    });
    recordMinerStats(caller, reward);
    totalMinted += reward; // reserve against the cap now, regardless of whether the transfer below succeeds

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

  // Anything that could hurt miners/holders in a single call -- making
  // mining free (difficulty), or redirecting where the ICP fee target
  // points -- goes through propose-now/execute-after-a-delay instead of
  // taking effect immediately. A compromised or careless controller key can
  // no longer drain remaining supply or redirect funds in one transaction:
  // the change sits in getPendingAdminChanges() for the full delay before it
  // can land, giving miners/holders a window to notice and react (or the
  // real controller a window to call the matching cancelPending*()).
  //
  // The delay is a hardcoded constant, not a controller-settable var -- a
  // setter for it would let a compromised key shorten it to zero right
  // before pushing a malicious change, defeating the entire point.
  let ADMIN_TIMELOCK_NANOS : Int = 48 * 60 * 60 * 1_000_000_000; // 48h

  var pendingDifficulty : ?Types.PendingNatChange = null;
  var pendingCyclesFundRatio : ?Types.PendingNatChange = null;
  var pendingIcpFeeTarget : ?Types.PendingIcpFeeTarget = null;

  public query func getPendingAdminChanges() : async Types.PendingAdminChanges {
    {
      difficulty = pendingDifficulty;
      cyclesFundRatio = pendingCyclesFundRatio;
      icpFeeTarget = pendingIcpFeeTarget;
      timelockNanos = ADMIN_TIMELOCK_NANOS;
    };
  };

  // MVP simplification: difficulty is still set manually by the controller
  // rather than an automatic retarget algorithm (see README) -- but only
  // takes effect ADMIN_TIMELOCK_NANOS after being proposed. Bounded to
  // [1, 256]: 0 would make every nonce a winning proof (free, unlimited
  // minting up to the supply cap in one script), and >256 is meaningless
  // (sha256 only has 256 bits to be zero).
  public shared ({ caller }) func proposeDifficulty(bits : Nat) : async () {
    requireController(caller);
    if (bits == 0 or bits > 256) {
      Runtime.trap("difficultyBits must be between 1 and 256");
    };
    pendingDifficulty := ?{ value = bits; readyAt = Time.now() + ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func cancelPendingDifficulty() : async () {
    requireController(caller);
    pendingDifficulty := null;
  };

  // Permissionless on purpose, like sweepTreasury() below -- the value was
  // already fixed (and publicly visible) at proposal time, so letting
  // anyone apply it once the timelock has elapsed just guarantees it lands
  // on schedule even if the controller key that proposed it is unavailable
  // by then.
  public shared func executeDifficulty() : async () {
    switch (pendingDifficulty) {
      case null { Runtime.trap("no pending difficulty change") };
      case (?p) {
        if (Time.now() < p.readyAt) {
          Runtime.trap("timelock has not elapsed yet");
        };
        difficultyBits := p.value;
        pendingDifficulty := null;
      };
    };
  };

  // Not timelocked: unlike difficulty or the ICP fee target, this can only
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
      let _burnOutcome = try {
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

  // Fires sweepTreasury() on a timer so the balance sitting in this
  // canister's own account never grows past roughly SWEEP_INTERVAL_SECONDS
  // worth of fees, without depending on an external keeper/cron to remember
  // to call it. Any error inside sweepTreasury() is already swallowed
  // internally (each leg just retries next time), so nothing further to
  // handle here.
  func armSweepTimer<system>() {
    switch (sweepTimerId) {
      case (?id) { Timer.cancelTimer(id) };
      case null {};
    };
    sweepTimerId := ?Timer.recurringTimer<system>(
      #seconds SWEEP_INTERVAL_SECONDS,
      func() : async () { ignore (await sweepTreasury()) },
    );
  };

  // Timers do not survive upgrades under enhanced orthogonal persistence
  // (same reason miner/src/main.mo re-arms its own timer here) -- and the
  // top-level armSweepTimer<system>() call below only runs on first install,
  // not on upgrade, so this is the only thing that re-arms it afterwards.
  system func postupgrade() {
    armSweepTimer<system>();
  };

  armSweepTimer<system>();
};
