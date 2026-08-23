import Principal "mo:core/Principal";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Blob "mo:core/Blob";
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Iter "mo:core/Iter";
import Time "mo:core/Time";
import Cycles "mo:core/Cycles";
import Runtime "mo:core/Runtime";
import Timer "mo:core/Timer";
import Map "mo:core/Map";
import Types "types";
import Cards "cards";

// PIKO Blackjack: a provably-fair, fully on-chain, interactive single-deck
// Blackjack game -- a sibling to PIKO Dice, same self-funding/escrow/
// timelock shape, different game. Single 52-card deck, shuffled
// once per round from one raw_rand call; dealer stands on all totals >=17
// (no soft-17 hit); blackjack pays 3:2, an ordinary win pays 2:1, a push
// returns the stake -- see getRules() for the disclosed, canonical
// numbers, including Double Down/Split (no insurance, no resplit, no
// double after split).
//
// Unlike spin() (a single atomic call), a round here genuinely spans
// several calls (deal -> hit* -> stand), which is a new shape for this
// canister and specifically why: (a) deal() takes a real per-principal
// lock (unlike the old spin(), which deliberately didn't need one), because
// state now persists across calls for the same player; and (b) an
// abandoned round needs an explicit resolution path
// (forceResolveRound/resolveExpiredRound below), because the funds it
// holds in committedPayout are a *shared* resource gating every player's
// ability to deal(), not just an inconvenience to whoever abandoned it.
actor self {

  // ---- Game constants ----
  let BLACKJACK_PAYOUT_BPS : Nat = 25_000; // natural blackjack pays 3:2 -- 2.5x total return
  let WIN_PAYOUT_BPS : Nat = 20_000; // an ordinary win pays 2:1 -- 2x total return
  let PUSH_PAYOUT_BPS : Nat = 10_000; // a tie returns the stake, 1x
  let DEALER_STANDS_ON : Nat = 17; // dealer hits below this, stands at/above it -- no soft-17 exception
  let ROUND_EXPIRY_NANOS : Int = 24 * 60 * 60 * 1_000_000_000; // 24h -- see resolveExpiredRound below

  func payoutBpsFor(status : Types.ResolvedStatus) : Nat {
    switch (status) {
      case (#PlayerBlackjack) { BLACKJACK_PAYOUT_BPS };
      case (#PlayerBust) { 0 };
      case (#DealerBust) { WIN_PAYOUT_BPS };
      case (#PlayerWin) { WIN_PAYOUT_BPS };
      case (#DealerWin) { 0 };
      case (#Push) { PUSH_PAYOUT_BPS };
    };
  };

  // Internal-only, never candid-facing (see types.mo's BlackjackView for
  // what actually gets returned to callers). Cards are the internal Nat8
  // 0..51 encoding cards.mo uses -- see viewOf/resolvedView below for the
  // *only* place these get converted (and, while #Open, redacted) into a
  // Types.BlackjackView. var fields make these genuinely mutable records
  // so hit()/stand()/etc. can mutate the copy already stored in `rounds`
  // in place via Map.get.
  //
  // NEVER return a Round (or its hands/dealerCards) directly to a caller --
  // always go through viewOf/resolvedView, which is what actually enforces
  // "the dealer's hidden hole card is never serialized while a round is
  // #Open".
  //
  // hands has length 1 normally, 2 after split() -- done marks a hand as
  // finished acting (stood, busted, or forced by doubleDown), distinct from
  // status, which stays null until the hand's actual outcome is knowable
  // (immediate on a bust, but only once every hand is done and the dealer
  // has played for anything else -- see finalizeWholeRound).
  type PlayerHand = {
    var cards : [Nat8];
    var betAmount : Nat;
    var done : Bool;
    var status : ?Types.ResolvedStatus;
  };

  type Round = {
    token : Types.TokenKind;
    amount : Nat; // the ORIGINAL per-hand bet, fixed at deal() time -- what doubleDown()/split() each pull one more unit of
    var reservedPayout : Nat; // 2.5x `amount` at deal() time (a natural's worst case); bumped once to 4x by doubleDown() or split() (see their own comments) -- always what committedPayout release uses, never the actual payout
    var actionInFlight : Bool; // true only during doubleDown()/split()'s ledger-pull await -- a real yield point hit()/stand() don't have, since they never await between reading and finalizing a round. Blocks every other action on this round (including forceResolveRound/resolveExpiredRound) until it clears, closing a race where the round could otherwise get finalized-and-removed out from under an in-flight double/split, stranding its just-pulled extra stake.
    deck : [Nat8]; // the whole 52-card deck, pre-shuffled and fixed for this round's entire lifetime
    var nextIndex : Nat; // cursor into deck -- hits, the dealer's own draws, and doubleDown()/split()'s extra cards all just consume the next card here, no further randomness needed after deal()
    var hands : [PlayerHand];
    var activeHandIndex : Nat; // which hand hit()/stand()/doubleDown() currently act on
    var dealerCards : [Nat8];
    openedAt : Time.Time; // for resolveExpiredRound below
  };

  let rounds : Map.Map<Principal, Round> = Map.empty<Principal, Round>();

  func unwrapStatus(hand : PlayerHand) : Types.ResolvedStatus {
    switch (hand.status) {
      case (?s) { s };
      case null { Runtime.trap("unreachable: hand status must be resolved before building a resolved view") };
    };
  };

  func viewOf(round : Round) : Types.BlackjackView {
    let hands = Array.map<PlayerHand, Types.PlayerHandView>(
      round.hands,
      func(h) { { cards = Array.map<Nat8, Types.Card>(h.cards, Cards.cardOf); total = Cards.handTotal(h.cards); status = h.status } },
    );
    // Double/split are only ever offered on an untouched, single, 2-card
    // hand -- computed here (not by the frontend) so the actual rule
    // authority never drifts from what's shown as enabled.
    let base = round.hands.size() == 1 and not round.hands[0].done and round.hands[0].cards.size() == 2 and not round.actionInFlight;
    let canDouble = base;
    let canSplit = base and Cards.rankOf(round.hands[0].cards[0]) == Cards.rankOf(round.hands[0].cards[1]);
    #Open({ hands; activeHandIndex = round.activeHandIndex; dealerUpCard = Cards.cardOf(round.dealerCards[0]); canDouble; canSplit });
  };

  func resolvedView(round : Round) : Types.BlackjackView {
    let hands = Array.map<PlayerHand, Types.ResolvedPlayerHandView>(
      round.hands,
      func(h) {
        let status = unwrapStatus(h);
        { cards = Array.map<Nat8, Types.Card>(h.cards, Cards.cardOf); total = Cards.handTotal(h.cards); status; betAmount = h.betAmount; payoutAmount = h.betAmount * payoutBpsFor(status) / 10_000 };
      },
    );
    var totalPayoutAmount = 0;
    for (h in hands.vals()) { totalPayoutAmount += h.payoutAmount };
    #Resolved({
      hands;
      dealerCards = Array.map<Nat8, Types.Card>(round.dealerCards, Cards.cardOf);
      dealerTotal = Cards.handTotal(round.dealerCards);
      totalPayoutAmount;
    });
  };

  // A hand whose status is still null needs the dealer's actual result to
  // resolve (it's done acting but not yet known win/lose/push) -- one still
  // needing that is what determines whether the dealer needs to draw at
  // all (skip entirely if every hand already resolved itself, e.g. all
  // busted, or a natural was already decided at deal() time).
  func dealerNeedsToPlay(hands : [PlayerHand]) : Bool {
    switch (Array.find<PlayerHand>(hands, func(h) { h.status == null })) {
      case (?_) { true };
      case null { false };
    };
  };

  func resolveHandVsDealer(hand : PlayerHand, dealerTotal : Nat) : Types.ResolvedStatus {
    let playerTotal = Cards.handTotal(hand.cards);
    if (dealerTotal > 21) { #DealerBust } else if (dealerTotal > playerTotal) { #DealerWin } else if (playerTotal > dealerTotal) { #PlayerWin } else { #Push };
  };

  // ---- Ledger wiring ----
  // PikoBlackjack is a standalone icp-cli project, not a piko-icp sibling
  // that deploys its own "ledger" canister -- so unlike dice's
  // pikoLedgerId (injected via PUBLIC_CANISTER_ID:ledger, a real
  // same-project dependency there), this defaults straight to the real,
  // live PIKO ledger by fixed principal, with a controller-only escape
  // hatch for pointing at a local test-ledger during development, closed
  // off for good by lockPikoLedgerId() before this is ever trusted with
  // real funds on mainnet -- see ../scripts/deploy-local.sh for the local
  // redirect.
  var pikoLedgerId : Principal = Principal.fromText("56aad-fiaaa-aaaaj-qsefa-cai");
  var pikoLedgerLocked : Bool = false;

  // Real mainnet ICP ledger by default; redirectable to a local test ledger
  // during development only, same as dice/mother's own icpLedgerId.
  var icpLedgerId : Principal = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  var cmcId : Principal = Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai");

  func requireController(caller : Principal) {
    if (not Principal.isController(caller)) { Runtime.trap("only a controller can call this") };
  };

  public shared ({ caller }) func setPikoLedgerId(id : Principal) : async () {
    requireController(caller);
    if (pikoLedgerLocked) { Runtime.trap("piko ledger id is permanently locked") };
    pikoLedgerId := id;
  };

  public shared ({ caller }) func lockPikoLedgerId() : async () {
    requireController(caller);
    pikoLedgerLocked := true;
  };

  // DEPRECATED, no longer read anywhere -- kept declared (not deleted) so
  // this deploy only ever ADDS a persisted field below, never removes one.
  // A direct rename (remove old name + add new name in the same upgrade)
  // was tried first and got rejected by a real mainnet upgrade attempt with
  // a hard "Memory-incompatible program upgrade" trap -- Motoko's EOP
  // upgrade-compatibility check treats a renamed top-level field as
  // remove-old+add-new, which it refuses outright, unlike a pure addition
  // (confirmed safe elsewhere this session, e.g. mother's diceId/plinkoId
  // additions). The rejection itself was atomic and safe (canister
  // untouched, verified), but not worth repeating for a cosmetic rename.
  // blackjackFrontendId below is the real field now.
  let plinkoFrontendId : ?Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:blackjack-frontend")) {
    case (?text) { ?Principal.fromText(text) };
    case null { null };
  };
  let blackjackFrontendId : ?Principal = switch (Runtime.envVar<system>("PUBLIC_CANISTER_ID:blackjack-frontend")) {
    case (?text) { ?Principal.fromText(text) };
    case null { null };
  };

  func ledgerIdFor(token : Types.TokenKind) : Principal {
    switch (token) { case (#ICP) { icpLedgerId }; case (#PIKO) { pikoLedgerId } };
  };

  // ---- Bankroll configuration (timelocked, see types.mo's BankrollConfig) ----
  var bankrollConfig : Types.BankrollConfig = {
    maxPayoutBps = 500; // 5% of live bankroll -- raised from the original 1% starting point once real play showed 1% capped bets too low to be fun; still timelocked for any future change from here
    icpBankrollFloorE8s = 0;
    cyclesFundRatioBps = 2000;
  };
  var bankrollConfigLocked : Bool = false;

  let ICP_LEDGER_FEE_E8S : Nat = 10_000;
  transient let SWEEP_INTERVAL_SECONDS_LIVE : Nat = 900; // 15 minutes, same cadence as mother/dice
  transient var sweepTimerId : ?Timer.TimerId = null;

  let MIN_MAINTENANCE_INTERVAL_NANOS : Int = 60_000_000_000; // 60s
  var lastSweepIcpProfitAt : Int = 0;
  var lastTopUpPlinkoFrontendAt : Int = 0; // DEPRECATED, no longer read -- see lastTopUpBlackjackFrontendAt and plinkoFrontendId's own comment above
  var lastTopUpBlackjackFrontendAt : Int = 0;

  let CYCLES_RESERVE : Nat = 2_000_000_000_000; // 2T, same floor as mother/dice

  // ---- Round state -- committedPayout mirrors dice's own of the same
  // name. Unlike the old spin() (which deliberately had no per-principal
  // lock, since several spins could be in flight from the same player at
  // once), a round's reservation now stays live across multiple calls
  // (deal -> hit* -> stand) via `rounds` itself acting as that lock -- see
  // the actor-level comment up top and deal()'s own comment below. ----
  transient var committedPayoutIcp : Nat = 0;
  transient var committedPayoutPiko : Nat = 0;

  func committedPayoutFor(token : Types.TokenKind) : Nat {
    switch (token) { case (#ICP) { committedPayoutIcp }; case (#PIKO) { committedPayoutPiko } };
  };
  func reserveCommittedPayout(token : Types.TokenKind, amount : Nat) {
    switch (token) {
      case (#ICP) { committedPayoutIcp += amount };
      case (#PIKO) { committedPayoutPiko += amount };
    };
  };
  func releaseCommittedPayout(token : Types.TokenKind, amount : Nat) {
    switch (token) {
      case (#ICP) { committedPayoutIcp -= amount };
      case (#PIKO) { committedPayoutPiko -= amount };
    };
  };

  // ---- Bankroll cache -- lets spin skip one of its three sequential
  // inter-canister awaits (the live balance check) on the hot path, which
  // was a meaningful share of the real time between clicking Spin and the
  // reels actually landing. Safe by construction: it can only ever
  // drift *low* relative to the true on-chain balance, never high --
  // incremented only after a *confirmed* successful stake pull, decremented
  // on every payout *attempt* regardless of whether it actually succeeded
  // (so a failed payout, funds still sitting right here, makes the cache
  // conservative rather than wrong in the unsafe direction). The one path
  // that could genuinely push it too high -- a controller withdrawal
  // actually leaving the canister -- refreshes it for real, synchronously,
  // inside executeWithdrawal itself, so that gap never opens at all rather
  // than waiting on the periodic resync below. A deposit (e.g. topping up
  // the bankroll) only ever makes the cache *under*-estimate until that
  // same periodic resync catches up -- also the safe direction.
  var pikoBankrollCache : Nat = 0;
  var icpBankrollCache : Nat = 0;
  var bankrollCacheInitialized : Bool = false;

  func bankrollCacheFor(token : Types.TokenKind) : Nat {
    switch (token) { case (#ICP) { icpBankrollCache }; case (#PIKO) { pikoBankrollCache } };
  };
  func setBankrollCache(token : Types.TokenKind, value : Nat) {
    switch (token) {
      case (#ICP) { icpBankrollCache := value };
      case (#PIKO) { pikoBankrollCache := value };
    };
  };
  // `delta` is a signed adjustment -- clamps at 0 rather than trapping on
  // underflow, since an under-clamped cache is still the safe direction.
  func adjustBankrollCache(token : Types.TokenKind, delta : Int) {
    let current : Int = bankrollCacheFor(token);
    let next = current + delta;
    setBankrollCache(token, if (next < 0) { 0 } else { Int.abs(next) });
  };

  func refreshBankrollCache(token : Types.TokenKind) : async () {
    let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerIdFor(token)));
    let balance = try {
      await Ledger.icrc1_balance_of({ owner = Principal.fromActor(self); subaccount = null });
    } catch (_e) { bankrollCacheFor(token) }; // keep the old value on failure rather than zeroing it out
    setBankrollCache(token, balance);
  };

  func ensureBankrollCacheInitialized() : async () {
    if (bankrollCacheInitialized) { return };
    await refreshBankrollCache(#PIKO);
    await refreshBankrollCache(#ICP);
    bankrollCacheInitialized := true;
  };

  // Controller-only manual lever for the same resync getStats() now does
  // passively on every poll (see its own comment) -- mainly useful right
  // after a direct deposit to this canister's own principal (bypassing
  // deal() entirely, so the cache's normal incremental updates never see
  // it) when you don't want to wait even one poll interval.
  public shared ({ caller }) func refreshBankrollCaches() : async () {
    requireController(caller);
    await refreshBankrollCache(#PIKO);
    await refreshBankrollCache(#ICP);
  };

  let pendingIcpPayouts : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
  let pendingPikoPayouts : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();

  var roundsPlayed : Nat = 0;
  var totalWageredIcpE8s : Nat = 0;
  var totalWageredPiko : Nat = 0;
  var totalPaidOutIcpE8s : Nat = 0;
  var totalPaidOutPiko : Nat = 0;

  let MAX_RECENT_ROUNDS : Nat = 20;
  var recentRounds : [Types.RecentRound] = [];

  let playerWageredIcp : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
  let playerWageredPiko : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();

  // ---- Helpers ----

  func addToMap(m : Map.Map<Principal, Nat>, p : Principal, amount : Nat) {
    let current = switch (Map.get(m, Principal.compare, p)) { case (?v) { v }; case null { 0 } };
    Map.add(m, Principal.compare, p, current + amount);
  };

  func pushRecentRound(d : Types.RecentRound) {
    let combined = Array.concat(recentRounds, [d]);
    let n = combined.size();
    recentRounds := if (n > MAX_RECENT_ROUNDS) {
      Array.tabulate<Types.RecentRound>(MAX_RECENT_ROUNDS, func(i) { combined[n - MAX_RECENT_ROUNDS + i] });
    } else { combined };
  };

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
      maxPayoutBps = bankrollConfig.maxPayoutBps;
      icpBankrollFloorE8s = bankrollConfig.icpBankrollFloorE8s;
      cyclesFundRatioBps = bankrollConfig.cyclesFundRatioBps;
      withdrawalsLocked;
      bankrollConfigLocked;
      icpLedgerId;
      pikoLedgerId;
    };
  };

  public query func getRules() : async Types.Rules {
    {
      deckCount = 1;
      dealerStandsOn = DEALER_STANDS_ON;
      blackjackPayoutBps = BLACKJACK_PAYOUT_BPS;
      doubleDownAllowed = true;
      splitAllowed = true;
      resplitAllowed = false;
      doubleAfterSplitAllowed = false;
      insuranceOffered = false;
      roundExpiryNanos = ROUND_EXPIRY_NANOS;
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
    // Free self-healing for the bankroll cache deal()/doubleDown()/split()
    // actually size bets against: this call already fetches both real
    // ledger balances live, and the frontend already polls getStats() every
    // few seconds, so piggybacking the resync here means a deposit sent
    // directly to this canister's own principal (bypassing deal() entirely,
    // so the cache's normal incremental updates never see it) gets picked
    // up within one poll interval instead of only on the next 15-minute
    // sweep-timer tick (see armSweepTimer) or a fresh deploy.
    setBankrollCache(#ICP, icpBankrollE8s);
    setBankrollCache(#PIKO, pikoBankroll);
    {
      roundsPlayed;
      totalWageredIcpE8s;
      totalWageredPiko;
      totalPaidOutIcpE8s;
      totalPaidOutPiko;
      icpBankrollE8s;
      pikoBankroll;
      cyclesBalance = Cycles.balance();
    };
  };

  public query func getRecentRounds() : async [Types.RecentRound] { recentRounds };

  public query ({ caller }) func getOpenRound() : async ?Types.BlackjackView {
    switch (Map.get(rounds, Principal.compare, caller)) {
      case (?round) { ?viewOf(round) };
      case null { null };
    };
  };

  // Operational-only: getOpenRound() is caller-scoped, so there's otherwise
  // no way to confirm zero rounds are open network-wide before a mainnet
  // reinstall (which wipes `rounds` regardless of any open round's state --
  // see the deploy notes this was added for).
  public query func getOpenRoundsCount() : async Nat { Map.size(rounds) };

  public query func getLeaderboard() : async [Types.LeaderboardEntry] {
    let seen : Map.Map<Principal, Bool> = Map.empty<Principal, Bool>();
    for (p in Map.keys(playerWageredIcp)) { Map.add(seen, Principal.compare, p, true) };
    for (p in Map.keys(playerWageredPiko)) { Map.add(seen, Principal.compare, p, true) };

    let entries = Array.map<Principal, Types.LeaderboardEntry>(
      Iter.toArray(Map.keys(seen)),
      func(p) {
        let wageredIcpE8s = switch (Map.get(playerWageredIcp, Principal.compare, p)) { case (?v) { v }; case null { 0 } };
        let wageredPiko = switch (Map.get(playerWageredPiko, Principal.compare, p)) { case (?v) { v }; case null { 0 } };
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
    switch (Map.get(m, Principal.compare, caller)) { case (?v) { v }; case null { 0 } };
  };

  public shared ({ caller }) func claimPendingPayout(token : Types.TokenKind) : async Types.ClaimResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    let m = switch (token) { case (#ICP) { pendingIcpPayouts }; case (#PIKO) { pendingPikoPayouts } };
    let owed = switch (Map.get(m, Principal.compare, caller)) { case (?v) { v }; case null { 0 } };
    if (owed == 0) { return #Err(#InvalidAmount) };
    Map.remove(m, Principal.compare, caller);
    await pay(token, caller, owed);
    #Ok(owed);
  };

  // Common finalize path for every way a round can end (bust via hit(),
  // stand()'s/doubleDown()'s dealer playout, a natural spotted right in
  // deal(), or the admin/expiry force-resolve paths below) -- draws the
  // dealer only if some hand still needs it, resolves every not-yet-
  // resolved hand against that one dealer result, sums payouts across
  // hands, releases the committed payout, updates counters/history exactly
  // once, and pays out the sum if anything is owed.
  func finalizeWholeRound(player : Principal, round : Round) : async Types.BlackjackView {
    if (dealerNeedsToPlay(round.hands)) {
      while (Cards.handTotal(round.dealerCards) < DEALER_STANDS_ON) {
        let card = round.deck[round.nextIndex];
        round.nextIndex += 1;
        round.dealerCards := Array.concat(round.dealerCards, [card]);
      };
    };
    let dealerTotal = Cards.handTotal(round.dealerCards);
    for (hand in round.hands.vals()) {
      if (hand.status == null) { hand.status := ?resolveHandVsDealer(hand, dealerTotal) };
    };

    let view = resolvedView(round);
    let resolved = switch (view) {
      case (#Resolved(r)) { r };
      case (#Open(_)) { Runtime.trap("unreachable: resolvedView always returns #Resolved") };
    };

    // Release the amount that was actually RESERVED (round.reservedPayout
    // -- 2.5x at deal() time, possibly bumped to 4x by doubleDown()/
    // split()), never the actual totalPayoutAmount computed above -- these
    // are two different numbers on purpose. Conflating them would still be
    // fund-safe (committedPayout never allows over-promising regardless of
    // which figure is used here) but would make the bankroll cache
    // collapse toward zero far faster than reality, causing spurious
    // BetTooLarge rejections well before the bankroll is actually
    // stressed -- see adjustBankrollCache below, which correctly uses the
    // *actual* payout instead.
    releaseCommittedPayout(round.token, round.reservedPayout);
    Map.remove(rounds, Principal.compare, player);

    roundsPlayed += 1;
    switch (round.token) {
      case (#ICP) { totalPaidOutIcpE8s += resolved.totalPayoutAmount };
      case (#PIKO) { totalPaidOutPiko += resolved.totalPayoutAmount };
    };
    pushRecentRound({
      player;
      token = round.token;
      amount = round.amount;
      hands = Array.map<Types.ResolvedPlayerHandView, { cards : [Types.Card]; status : Types.ResolvedStatus; payoutAmount : Nat }>(
        resolved.hands,
        func(h) { { cards = h.cards; status = h.status; payoutAmount = h.payoutAmount } },
      );
      dealerCards = resolved.dealerCards;
      timestamp = Time.now();
    });

    if (resolved.totalPayoutAmount > 0) {
      adjustBankrollCache(round.token, -resolved.totalPayoutAmount); // the ACTUAL payout -- see the comment above releaseCommittedPayout
      await pay(round.token, player, resolved.totalPayoutAmount);
    };

    view;
  };

  // If another hand is still waiting to be played, move to it; otherwise
  // every hand is done and the whole round finalizes. Shared by hit()
  // (only once the active hand becomes done), stand(), and doubleDown()
  // (which always forces its hand done).
  func advanceOrFinalizeRound(player : Principal, round : Round) : async Types.BlackjackView {
    if (round.activeHandIndex + 1 < round.hands.size()) {
      round.activeHandIndex += 1;
      viewOf(round);
    } else {
      await finalizeWholeRound(player, round);
    };
  };

  // Sizes against the *worst-case* payout (a natural blackjack, 2.5x stake)
  // since which cards land isn't known until after raw_rand resolves the
  // whole deck's order, well after the stake is already gone -- same
  // "commit funds before revealing the outcome" ordering the old spin()
  // used, for the same reason. Unlike spin(), this reservation stays live
  // across every later hit()/stand()/doubleDown()/split() call for this
  // round too (see finalizeWholeRound above) -- which is exactly why,
  // unlike spin(), deal() takes a real per-principal lock: `rounds` map
  // membership itself is the lock, checked before any await, since state
  // genuinely has to persist across calls here (a second deal() while one
  // is already open would otherwise let the same player commit two
  // overlapping worst-case reservations against shared bankroll headroom
  // under one identity).
  public shared ({ caller }) func deal<system>(token : Types.TokenKind, amountE8s : Nat) : async Types.BlackjackResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    if (amountE8s == 0) { return #Err(#InvalidAmount) };
    switch (Map.get(rounds, Principal.compare, caller)) {
      case (?_) { return #Err(#RoundAlreadyOpen) };
      case null {};
    };

    let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerIdFor(token)));
    let Management : Types.ManagementActor = actor ("aaaaa-aa");
    await ensureBankrollCacheInitialized(); // a no-op await after the very first round ever -- see the cache's own comment
    let bankroll = bankrollCacheFor(token);

    let reservedPayout = amountE8s * BLACKJACK_PAYOUT_BPS / 10_000;
    let maxPayoutAllowed = bankroll * bankrollConfig.maxPayoutBps / 10_000;
    let alreadyCommitted = committedPayoutFor(token);
    let remainingAllowed = if (maxPayoutAllowed > alreadyCommitted) { maxPayoutAllowed - alreadyCommitted } else { 0 };
    if (reservedPayout > remainingAllowed) {
      return #Err(#BetTooLarge({ maxPayout = remainingAllowed }));
    };
    reserveCommittedPayout(token, reservedPayout);

    // Fired concurrently, not one after the other -- raw_rand doesn't
    // depend on the stake pull's outcome (if the pull ultimately fails,
    // this entropy is simply discarded below, unused), so there's no
    // fairness reason to serialize them: the player never learns anything
    // from either call until this whole function returns regardless of
    // which order they actually complete in. Awaiting both concurrently
    // means this call pays for roughly the *slower* of the two
    // inter-canister round trips, not their sum, which is most of where
    // deal()'s real end-to-end latency was going.
    let transferFuture = Ledger.icrc2_transfer_from({
      spender_subaccount = null;
      from = { owner = caller; subaccount = null };
      to = { owner = Principal.fromActor(self); subaccount = null };
      amount = amountE8s;
      fee = null;
      memo = null;
      created_at_time = null;
    });
    let randFuture = Management.raw_rand();

    let pullOutcome = try { ?(await transferFuture) } catch (_e) { null };
    let randOutcome = try { ?(await randFuture) } catch (_e) { null };

    switch (pullOutcome) {
      case (? #Ok(_)) { adjustBankrollCache(token, amountE8s) };
      case (? #Err(e)) {
        releaseCommittedPayout(token, reservedPayout);
        return #Err(#TransferFailed(e));
      };
      case null {
        releaseCommittedPayout(token, reservedPayout);
        return #Err(#TransferFailed(#TemporarilyUnavailable));
      };
    };

    // Wagered counters record right here, the moment the stake is actually
    // pulled -- regardless of whether the round later gets abandoned (see
    // ROUND_EXPIRY_NANOS/resolveExpiredRound below) -- matching "wagered"
    // meaning "pulled from the player". roundsPlayed/totalPaidOut* only
    // update once the round actually resolves, in finalizeWholeRound.
    switch (token) {
      case (#ICP) { totalWageredIcpE8s += amountE8s; addToMap(playerWageredIcp, caller, amountE8s) };
      case (#PIKO) { totalWageredPiko += amountE8s; addToMap(playerWageredPiko, caller, amountE8s) };
    };

    let entropy = switch (randOutcome) {
      case (?bytes) { bytes };
      case null {
        releaseCommittedPayout(token, reservedPayout);
        adjustBankrollCache(token, -amountE8s);
        await pay(token, caller, amountE8s); // refund
        return #Err(#RandomnessFailed);
      };
    };

    // The *entire* 52-card deck is shuffled right here, once, from this
    // round's one and only raw_rand call -- hit()/stand() (and the dealer's
    // own draws) just consume the next fixed card off this same deck by
    // index afterwards, no further randomness round-trips needed, which is
    // also why they're faster than deal() itself.
    let deckVar = VarArray.fromArray<Nat8>(Cards.freshDeck());
    Cards.shuffle(deckVar, Cards.entropyToNat(Blob.toArray(entropy)));
    let deck = VarArray.toArray<Nat8>(deckVar);

    let round : Round = {
      token;
      amount = amountE8s;
      var reservedPayout = reservedPayout;
      var actionInFlight = false;
      deck;
      var nextIndex = 4;
      var hands = [{ var cards = [deck[0], deck[1]]; var betAmount = amountE8s; var done = false; var status = null }];
      var activeHandIndex = 0;
      var dealerCards = [deck[2], deck[3]];
      openedAt = Time.now();
    };

    // Re-check right before actually claiming the slot: three awaits have
    // happened since the check at the top of this call (the bankroll cache
    // init, the stake pull, raw_rand), so a second concurrent deal() from
    // this same principal could in principle have already landed its own
    // round in the meantime. Overwriting it via Map.add would silently
    // orphan that round's reservedPayout forever (nothing could ever reach
    // it via `rounds` again to release it) -- refund this pull instead.
    switch (Map.get(rounds, Principal.compare, caller)) {
      case (?_) {
        releaseCommittedPayout(token, reservedPayout);
        adjustBankrollCache(token, -amountE8s);
        await pay(token, caller, amountE8s);
        return #Err(#RoundAlreadyOpen);
      };
      case null {};
    };
    Map.add(rounds, Principal.compare, caller, round);

    // Eager "dealer peek": both hands are checked for a natural right here,
    // before ever returning -- this is what makes a later "a natural beats
    // any later 3-card 21" special case unnecessary (past this point,
    // naturals are already fully ruled out for both sides). No split hand
    // can ever be a natural (see split() below), so this is the only place
    // #PlayerBlackjack ever gets assigned.
    let hand = round.hands[0];
    let playerNatural = Cards.handTotal(hand.cards) == 21;
    let dealerNatural = Cards.handTotal(round.dealerCards) == 21;
    if (playerNatural or dealerNatural) {
      hand.status := ?(if (playerNatural and dealerNatural) { #Push } else if (playerNatural) { #PlayerBlackjack } else { #DealerWin });
      let view = await finalizeWholeRound(caller, round);
      return #Ok(view);
    };

    #Ok(viewOf(round));
  };

  public shared ({ caller }) func hit() : async Types.BlackjackResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    switch (Map.get(rounds, Principal.compare, caller)) {
      case null { #Err(#NoOpenRound) };
      case (?round) {
        if (round.actionInFlight) { return #Err(#ActionNotAllowed) };
        let hand = round.hands[round.activeHandIndex];
        if (hand.done) { return #Err(#ActionNotAllowed) };
        let card = round.deck[round.nextIndex];
        round.nextIndex += 1;
        hand.cards := Array.concat(hand.cards, [card]);
        if (Cards.handTotal(hand.cards) > 21) {
          hand.status := ?#PlayerBust;
          hand.done := true;
          let view = await advanceOrFinalizeRound(caller, round);
          #Ok(view);
        } else {
          #Ok(viewOf(round));
        };
      };
    };
  };

  public shared ({ caller }) func stand() : async Types.BlackjackResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    switch (Map.get(rounds, Principal.compare, caller)) {
      case null { #Err(#NoOpenRound) };
      case (?round) {
        if (round.actionInFlight) { return #Err(#ActionNotAllowed) };
        let hand = round.hands[round.activeHandIndex];
        if (hand.done) { return #Err(#ActionNotAllowed) };
        hand.done := true;
        let view = await advanceOrFinalizeRound(caller, round);
        #Ok(view);
      };
    };
  };

  // Only on a hand's untouched initial 2 cards, only when the round hasn't
  // been split (hands.size()==1 -- also what blocks double-after-split and
  // re-double). Doubles the bet (one more icrc2_transfer_from of the
  // ORIGINAL amount), draws exactly one more card, forces the hand done.
  //
  // Worst case from here is 4x the original bet (2x the now-doubled bet at
  // WIN_PAYOUT_BPS) -- see the module comment/plan this was built from for
  // why that's the same ceiling split() reserves, so both share this exact
  // reservation-bump shape.
  public shared ({ caller }) func doubleDown() : async Types.BlackjackResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    switch (Map.get(rounds, Principal.compare, caller)) {
      case null { #Err(#NoOpenRound) };
      case (?round) {
        if (round.actionInFlight) { return #Err(#ActionNotAllowed) };
        if (round.hands.size() != 1 or round.hands[0].done or round.hands[0].cards.size() != 2) {
          return #Err(#ActionNotAllowed);
        };
        let hand = round.hands[0];

        let newWorstCase = round.amount * 2 * WIN_PAYOUT_BPS / 10_000; // 4x original
        let extra = if (newWorstCase > round.reservedPayout) { newWorstCase - round.reservedPayout } else { 0 };
        let bankroll = bankrollCacheFor(round.token);
        let maxPayoutAllowed = bankroll * bankrollConfig.maxPayoutBps / 10_000;
        let alreadyCommitted = committedPayoutFor(round.token);
        let remainingAllowed = if (maxPayoutAllowed > alreadyCommitted) { maxPayoutAllowed - alreadyCommitted } else { 0 };
        if (extra > remainingAllowed) {
          return #Err(#BetTooLarge({ maxPayout = remainingAllowed }));
        };
        // Reserved and locked synchronously, before the only await below --
        // see actionInFlight's own comment on Round for exactly why this
        // lock exists (hit()/stand() never needed one).
        reserveCommittedPayout(round.token, extra);
        round.actionInFlight := true;

        let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerIdFor(round.token)));
        let pullOutcome = try {
          ?(
            await Ledger.icrc2_transfer_from({
              spender_subaccount = null;
              from = { owner = caller; subaccount = null };
              to = { owner = Principal.fromActor(self); subaccount = null };
              amount = round.amount;
              fee = null;
              memo = null;
              created_at_time = null;
            })
          );
        } catch (_e) { null };

        switch (pullOutcome) {
          case (? #Ok(_)) {
            switch (Map.get(rounds, Principal.compare, caller)) {
              case (?_) {
                round.actionInFlight := false;
                adjustBankrollCache(round.token, round.amount);
                switch (round.token) {
                  case (#ICP) { totalWageredIcpE8s += round.amount; addToMap(playerWageredIcp, caller, round.amount) };
                  case (#PIKO) { totalWageredPiko += round.amount; addToMap(playerWageredPiko, caller, round.amount) };
                };
                round.reservedPayout := newWorstCase;
                hand.betAmount := round.amount * 2;
                let card = round.deck[round.nextIndex];
                round.nextIndex += 1;
                hand.cards := Array.concat(hand.cards, [card]);
                hand.done := true;
                if (Cards.handTotal(hand.cards) > 21) { hand.status := ?#PlayerBust };
                let view = await advanceOrFinalizeRound(caller, round);
                #Ok(view);
              };
              case null {
                // Round was force/expiry-resolved while this pull was in
                // flight (blocked from racing on this round specifically by
                // actionInFlight, but a controller/expiry call targeting a
                // *different* round obviously isn't) -- refund the just-
                // pulled extra stake and release our reservation bump (the
                // round's own finalize already released its OLD
                // reservedPayout, from before we bumped it, so `extra`
                // would otherwise leak permanently).
                releaseCommittedPayout(round.token, extra);
                await pay(round.token, caller, round.amount);
                #Err(#ActionNotAllowed);
              };
            };
          };
          case (? #Err(e)) {
            releaseCommittedPayout(round.token, extra);
            round.actionInFlight := false;
            #Err(#TransferFailed(e));
          };
          case null {
            releaseCommittedPayout(round.token, extra);
            round.actionInFlight := false;
            #Err(#TransferFailed(#TemporarilyUnavailable));
          };
        };
      };
    };
  };

  // Only on the initial 2 cards, only when they share a rank, only once
  // (hands.size()==1 blocks re-split same as it blocks double-after-split).
  // Splits into 2 independent hands (each original card + one freshly
  // dealt card), each with its own amount-sized bet (a second
  // icrc2_transfer_from pull). No split hand can ever be a natural --
  // see the module comment: the 3:2 bonus only ever comes from the
  // original pre-split deal, already fully resolved before split() is ever
  // reachable -- so a split hand landing 21 is just an ordinary strong win.
  public shared ({ caller }) func split() : async Types.BlackjackResult {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    switch (Map.get(rounds, Principal.compare, caller)) {
      case null { #Err(#NoOpenRound) };
      case (?round) {
        if (round.actionInFlight) { return #Err(#ActionNotAllowed) };
        if (round.hands.size() != 1 or round.hands[0].done or round.hands[0].cards.size() != 2) {
          return #Err(#ActionNotAllowed);
        };
        let original = round.hands[0];
        if (Cards.rankOf(original.cards[0]) != Cards.rankOf(original.cards[1])) {
          return #Err(#ActionNotAllowed);
        };

        // Same 4x ceiling as doubleDown() -- 2 hands, each capped at
        // WIN_PAYOUT_BPS on `amount`, coincidentally equal to doubling one
        // hand's bet then capping it at WIN_PAYOUT_BPS too.
        let newWorstCase = round.amount * 2 * WIN_PAYOUT_BPS / 10_000;
        let extra = if (newWorstCase > round.reservedPayout) { newWorstCase - round.reservedPayout } else { 0 };
        let bankroll = bankrollCacheFor(round.token);
        let maxPayoutAllowed = bankroll * bankrollConfig.maxPayoutBps / 10_000;
        let alreadyCommitted = committedPayoutFor(round.token);
        let remainingAllowed = if (maxPayoutAllowed > alreadyCommitted) { maxPayoutAllowed - alreadyCommitted } else { 0 };
        if (extra > remainingAllowed) {
          return #Err(#BetTooLarge({ maxPayout = remainingAllowed }));
        };
        reserveCommittedPayout(round.token, extra);
        round.actionInFlight := true;

        let Ledger : Types.LedgerActor = actor (Principal.toText(ledgerIdFor(round.token)));
        let pullOutcome = try {
          ?(
            await Ledger.icrc2_transfer_from({
              spender_subaccount = null;
              from = { owner = caller; subaccount = null };
              to = { owner = Principal.fromActor(self); subaccount = null };
              amount = round.amount;
              fee = null;
              memo = null;
              created_at_time = null;
            })
          );
        } catch (_e) { null };

        switch (pullOutcome) {
          case (? #Ok(_)) {
            switch (Map.get(rounds, Principal.compare, caller)) {
              case (?_) {
                round.actionInFlight := false;
                adjustBankrollCache(round.token, round.amount);
                switch (round.token) {
                  case (#ICP) { totalWageredIcpE8s += round.amount; addToMap(playerWageredIcp, caller, round.amount) };
                  case (#PIKO) { totalWageredPiko += round.amount; addToMap(playerWageredPiko, caller, round.amount) };
                };
                round.reservedPayout := newWorstCase;
                let card1 = round.deck[round.nextIndex];
                let card2 = round.deck[round.nextIndex + 1];
                round.nextIndex += 2;
                round.hands := [
                  { var cards = [original.cards[0], card1]; var betAmount = round.amount; var done = false; var status = null },
                  { var cards = [original.cards[1], card2]; var betAmount = round.amount; var done = false; var status = null },
                ];
                round.activeHandIndex := 0;
                #Ok(viewOf(round));
              };
              case null {
                releaseCommittedPayout(round.token, extra);
                await pay(round.token, caller, round.amount);
                #Err(#ActionNotAllowed);
              };
            };
          };
          case (? #Err(e)) {
            releaseCommittedPayout(round.token, extra);
            round.actionInFlight := false;
            #Err(#TransferFailed(e));
          };
          case null {
            releaseCommittedPayout(round.token, extra);
            round.actionInFlight := false;
            #Err(#TransferFailed(#TemporarilyUnavailable));
          };
        };
      };
    };
  };

  // Controller-only, no timelock (moves nothing, can't target anyone
  // unfairly, just forces a fair conclusion on cards already fairly
  // shuffled at deal() time) -- the deliberate escape hatch for an
  // abandoned round: since committedPayout is a *shared* cap gating every
  // player's deal(), an abandoned round doesn't just cost the player who
  // opened it, it eats into everyone else's betting headroom until
  // resolved. See also resolveExpiredRound below, the permissionless
  // long-fuse equivalent. Rejected while actionInFlight -- see that
  // field's own comment on Round for why racing this against an in-flight
  // doubleDown()/split() specifically must not be allowed to proceed.
  public shared ({ caller }) func forceResolveRound(player : Principal) : async Types.BlackjackResult {
    requireController(caller);
    switch (Map.get(rounds, Principal.compare, player)) {
      case null { #Err(#NoOpenRound) };
      case (?round) {
        if (round.actionInFlight) { return #Err(#ActionNotAllowed) };
        // Every not-yet-done hand is forced done -- not just whichever was
        // active -- so an abandoned round walked away from mid-way through
        // hand 2 of a split still gets that hand fairly concluded too.
        for (hand in round.hands.vals()) { if (not hand.done) { hand.done := true } };
        let view = await finalizeWholeRound(player, round);
        #Ok(view);
      };
    };
  };

  // Permissionless, but only once a round has genuinely sat open past
  // ROUND_EXPIRY_NANOS (24h, see getRules()) -- bounds worst-case aggregate
  // committedPayout exposure from abandoned rounds to "however many can be
  // opened in one expiry window", rather than "until an admin happens to
  // notice". Anyone can call this for anyone; it can only ever conclude an
  // already-fairly-dealt hand exactly the way stand() would, never change
  // its outcome.
  public shared func resolveExpiredRound(player : Principal) : async Types.BlackjackResult {
    switch (Map.get(rounds, Principal.compare, player)) {
      case null { #Err(#NoOpenRound) };
      case (?round) {
        if (round.actionInFlight) { return #Err(#ActionNotAllowed) };
        if (Time.now() - round.openedAt < ROUND_EXPIRY_NANOS) { Runtime.trap("round has not expired yet") };
        for (hand in round.hands.vals()) { if (not hand.done) { hand.done := true } };
        let view = await finalizeWholeRound(player, round);
        #Ok(view);
      };
    };
  };

  // ---- Admin (controller-only, timelocked -- identical shape to dice's) ----

  let ADMIN_TIMELOCK_NANOS : Int = 48 * 60 * 60 * 1_000_000_000; // 48h, same as mother/dice

  var pendingBankrollConfig : ?Types.PendingBankrollConfig = null;
  var pendingWithdrawal : ?Types.PendingWithdrawal = null;
  var withdrawalsLocked : Bool = false;

  public query func getPendingAdminChanges() : async Types.PendingAdminChanges {
    { bankrollConfig = pendingBankrollConfig; withdrawal = pendingWithdrawal; timelockNanos = ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func proposeBankrollConfig(value : Types.BankrollConfig) : async () {
    requireController(caller);
    if (bankrollConfigLocked) { Runtime.trap("bankroll config is permanently locked") };
    if (value.cyclesFundRatioBps > 10_000) { Runtime.trap("cyclesFundRatioBps must be <= 10000 (100%)") };
    if (value.maxPayoutBps > 10_000) { Runtime.trap("maxPayoutBps must be <= 10000 (100%)") };
    pendingBankrollConfig := ?{ value; readyAt = Time.now() + ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func cancelPendingBankrollConfig() : async () {
    requireController(caller);
    pendingBankrollConfig := null;
  };

  public shared func executeBankrollConfig() : async () {
    switch (pendingBankrollConfig) {
      case null { Runtime.trap("no pending bankroll config change") };
      case (?p) {
        if (Time.now() < p.readyAt) { Runtime.trap("timelock has not elapsed yet") };
        if (bankrollConfigLocked) { Runtime.trap("bankroll config is permanently locked") };
        bankrollConfig := p.value;
        pendingBankrollConfig := null;
      };
    };
  };

  public shared ({ caller }) func lockBankrollConfig() : async () {
    requireController(caller);
    bankrollConfigLocked := true;
    pendingBankrollConfig := null;
  };

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
        let result = await Ledger.icrc1_transfer({
          from_subaccount = null;
          to = { owner = p.to; subaccount = null };
          amount = p.amount;
          fee = null;
          memo = null;
          created_at_time = null;
        });
        // The one operation that could otherwise push the bankroll cache
        // higher than the real balance (see its own comment) -- refreshed
        // for real, right here, so that gap never opens at all.
        await refreshBankrollCache(p.token);
        result;
      };
    };
  };

  public shared ({ caller }) func lockWithdrawals() : async () {
    requireController(caller);
    withdrawalsLocked := true;
    pendingWithdrawal := null;
  };

  // ---- Profit sweep (ICP surplus -> cycles), identical shape to dice's ----
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
    let now = Time.now();
    if (now - lastSweepIcpProfitAt < MIN_MAINTENANCE_INTERVAL_NANOS) {
      return { profit = 0; cyclesFunded = 0; cyclesMinted = null; notifyError = null };
    };
    lastSweepIcpProfitAt := now;

    let IcpLedger : Types.LedgerActor = actor (Principal.toText(icpLedgerId));
    let self_ = Principal.fromActor(self);
    let balance = await IcpLedger.icrc1_balance_of({ owner = self_; subaccount = null });
    setBankrollCache(#ICP, balance); // this sweep already runs on a timer -- free periodic resync for the ICP side of the bankroll cache
    let floor = bankrollConfig.icpBankrollFloorE8s + ICP_LEDGER_FEE_E8S;
    if (balance <= floor) {
      return { profit = 0; cyclesFunded = 0; cyclesMinted = null; notifyError = null };
    };

    let profit = balance - floor;
    let cyclesAmount = profit * bankrollConfig.cyclesFundRatioBps / 10_000;
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
        adjustBankrollCache(#ICP, -cyclesAmount);
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

  public shared func topUpBlackjackFrontend() : async { sent : Nat } {
    let now = Time.now();
    if (now - lastTopUpBlackjackFrontendAt < MIN_MAINTENANCE_INTERVAL_NANOS) { return { sent = 0 } };
    lastTopUpBlackjackFrontendAt := now;

    let balance = Cycles.balance();
    if (balance <= CYCLES_RESERVE) { return { sent = 0 } };
    switch (blackjackFrontendId) {
      case null { { sent = 0 } };
      case (?target) {
        let surplus = balance - CYCLES_RESERVE;
        let Management : Types.ManagementActor = actor ("aaaaa-aa");
        let outcome = try {
          await (with cycles = surplus) Management.deposit_cycles({ canister_id = target });
          ?();
        } catch (_e) { null };
        switch (outcome) {
          case (?()) { { sent = surplus } };
          case null { { sent = 0 } };
        };
      };
    };
  };

  func armSweepTimer<system>() {
    switch (sweepTimerId) { case (?id) { Timer.cancelTimer(id) }; case null {} };
    sweepTimerId := ?Timer.recurringTimer<system>(
      #seconds SWEEP_INTERVAL_SECONDS_LIVE,
      func() : async () {
        ignore (await sweepIcpProfit());
        ignore (await topUpBlackjackFrontend());
        // sweepIcpProfit already resyncs the ICP side of the bankroll
        // cache for free; PIKO has no equivalent periodic sweep of its
        // own, so resync it here on the same cadence.
        await refreshBankrollCache(#PIKO);
      },
    );
  };

  // committedPayoutIcp/committedPayoutPiko are `transient` (see their own
  // declarations) so they reset to 0 on every upgrade -- but `rounds` is
  // NOT transient, it persists real open rounds with a real reservedPayout
  // across upgrades. Without this, an upgrade deployed while a round is
  // open would leave committedPayout understating the true reservation;
  // when that round later resolves, releaseCommittedPayout would subtract
  // from a 0 (or too-low) counter and trap on the Nat underflow, permanently
  // stranding that round (and the stake already pulled from the player) --
  // every retry re-traps the same way. Fixed by resyncing committedPayout
  // to the ground truth (the sum of every still-open round's reservedPayout)
  // on every upgrade, exactly like refreshBankrollCache resyncs the other
  // cache from its own ground truth (the live ledger balance).
  func recomputeCommittedPayout() {
    var icp = 0;
    var piko = 0;
    for (round in Map.values(rounds)) {
      switch (round.token) {
        case (#ICP) { icp += round.reservedPayout };
        case (#PIKO) { piko += round.reservedPayout };
      };
    };
    committedPayoutIcp := icp;
    committedPayoutPiko := piko;
  };

  system func postupgrade() {
    armSweepTimer<system>();
    recomputeCommittedPayout();
    // One-time migration for the plinko->blackjack field rename above --
    // only fires the instant lastTopUpBlackjackFrontendAt is introduced at
    // its default 0; afterward it's always a real nonzero Time.now() value,
    // so this never re-fires and never clobbers real progress on a later
    // upgrade.
    if (lastTopUpBlackjackFrontendAt == 0) {
      lastTopUpBlackjackFrontendAt := lastTopUpPlinkoFrontendAt;
    };
  };

  armSweepTimer<system>();
};
