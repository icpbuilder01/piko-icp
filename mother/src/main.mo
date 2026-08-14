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
  var totalMinted : Nat = 0;
  // ICP burned (sent to the ICP ledger's minting account) per accepted
  // block, in e8s. Default 0.001 ICP -- adjustable via setMiningFeeE8s().
  var miningFeeE8s : Nat = 100_000;

  var recentBlocks : [Types.Block] = [];
  transient let pendingRewards : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
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
  // failed mint never blocks the chain, it just needs a retry.
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
      case (? #Ok(_)) { totalMinted += amount };
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

  public query func cyclesBalance() : async Nat {
    Cycles.balance();
  };

  // Verifies sha256(previousHash # height # nonce) server-side (never trusts
  // a client-supplied hash), burns the ICP mining fee from the caller (they
  // must have called icrc2_approve on the ICP ledger beforehand), then
  // advances the chain and mints the reward.
  //
  // This is pay-to-play, not play-to-win: the fee is burned the moment a
  // valid proof is submitted, whether or not this submission goes on to win
  // the block. If another submission's fee pull happens to land first during
  // this call's own await below, this one loses the race and its fee is
  // *not* refunded -- same as real proof-of-work, where compute spent on a
  // block someone else found first is never reimbursed. That real, unrefunded
  // cost is what makes mining an actual competition instead of a free-roll;
  // see README.
  //
  // Ordering: cheap local checks first (anonymity, rate limit, hash
  // validity), then the costly inter-canister fee burn, then a freshness
  // re-check (another submission could have advanced the chain while we
  // were awaiting the burn) purely to protect correctness -- so this
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
      let burnOutcome = try {
        ?(
          await IcpLedger.icrc2_transfer_from({
            spender_subaccount = null;
            from = { owner = caller; subaccount = null };
            to = { owner = icpBurnOwner; subaccount = null };
            amount = miningFeeE8s;
            fee = null;
            memo = null;
            created_at_time = null;
          })
        );
      } catch (_e) { null };

      switch (burnOutcome) {
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
  // MVP simplification: difficulty and the mining fee are set manually by
  // the controller instead of an automatic retarget algorithm (see README).
  public shared ({ caller }) func setDifficulty(bits : Nat) : async () {
    if (not Principal.isController(caller)) {
      Runtime.trap("only a controller can set difficulty");
    };
    difficultyBits := bits;
  };

  public shared ({ caller }) func setMiningFeeE8s(e8s : Nat) : async () {
    if (not Principal.isController(caller)) {
      Runtime.trap("only a controller can set the mining fee");
    };
    miningFeeE8s := e8s;
  };

  // Only meant for pointing this canister at a local test ICRC ledger while
  // verifying the fee-burn logic (the real ICP ledger only exists on
  // mainnet) -- not expected to ever be called against the mainnet deployment.
  public shared ({ caller }) func setIcpFeeTarget(ledgerId : Principal, burnOwner : Principal) : async () {
    if (not Principal.isController(caller)) {
      Runtime.trap("only a controller can set the ICP fee target");
    };
    icpLedgerId := ledgerId;
    icpBurnOwner := burnOwner;
  };
};
