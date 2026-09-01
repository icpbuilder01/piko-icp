import Time "mo:core/Time";

module {
  /// Same minimal ICRC-1/ICRC-2 interface dice/mother declare locally for
  /// their own ledgers -- duplicated here rather than imported
  /// cross-canister (this project family's existing convention).
  public type Account = { owner : Principal; subaccount : ?Blob };

  public type TransferArg = {
    from_subaccount : ?Blob;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #TemporarilyUnavailable;
    #Duplicate : { duplicate_of : Nat };
    #GenericError : { error_code : Nat; message : Text };
  };

  public type TransferResult = { #Ok : Nat; #Err : TransferError };

  public type TransferFromArgs = {
    spender_subaccount : ?Blob;
    from : Account;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferFromError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #InsufficientAllowance : { allowance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type TransferFromResult = { #Ok : Nat; #Err : TransferFromError };

  public type LedgerActor = actor {
    icrc2_transfer_from : (TransferFromArgs) -> async TransferFromResult;
    icrc1_transfer : (TransferArg) -> async TransferResult;
    icrc1_balance_of : (Account) -> async Nat;
  };

  /// Cycles Minting Canister -- converts a share of realized ICP profit into
  /// cycles, exactly like mother's/dice's own sweep. Mainnet CMC:
  /// rkp4c-7iaaa-aaaaa-aaaca-cai.
  public type NotifyTopUpArg = { block_index : Nat64; canister_id : Principal };

  public type NotifyError = {
    #Refunded : { reason : Text; block_index : ?Nat64 };
    #Processing;
    #TransactionTooOld : Nat64;
    #InvalidTransaction : Text;
    #Other : { error_code : Nat64; error_message : Text };
  };

  public type NotifyTopUpResult = { #Ok : Nat; #Err : NotifyError };

  public type CmcActor = actor {
    notify_top_up : (NotifyTopUpArg) -> async NotifyTopUpResult;
  };

  /// The IC management canister. raw_rand resolves every spin -- see
  /// spin() in main.mo for why it's only ever called *after* the stake
  /// has already been pulled from the player. deposit_cycles shares this
  /// canister's own cycles surplus with blackjack-frontend, same pattern as
  /// mother.topUpProject()/dice.topUpDiceFrontend().
  public type ManagementActor = actor {
    raw_rand : () -> async Blob;
    deposit_cycles : ({ canister_id : Principal }) -> async ();
  };

  /// Which ledger a spin is denominated in. Kept dual (like dice), even
  /// though blackjack-frontend only ever offers PIKO: an ICP path is what lets
  /// this canister self-fund its own cycles via sweepIcpProfit(), the same
  /// reason dice keeps it -- CMC only ever converts ICP, never PIKO.
  public type TokenKind = { #ICP; #PIKO };

  /// A standard 52-card deck's rank/suit, exposed candid-facing as an
  /// explicit variant pair (rather than the internal Nat8 0..51 encoding
  /// cards.mo actually shuffles/deals against -- see its own comment) so
  /// any caller can render a hand without needing that encoding out of
  /// band, matching this project's disclosed-fairness ethos.
  public type CardRank = { #Two; #Three; #Four; #Five; #Six; #Seven; #Eight; #Nine; #Ten; #Jack; #Queen; #King; #Ace };
  public type CardSuit = { #Hearts; #Diamonds; #Clubs; #Spades };
  public type Card = { rank : CardRank; suit : CardSuit };

  /// How a resolved round ended. PlayerBlackjack/PlayerBust/DealerBust are
  /// their own outcomes (rather than folding into PlayerWin/DealerWin)
  /// because each pays a different multiple -- see main.mo's
  /// BLACKJACK_PAYOUT_BPS/WIN_PAYOUT_BPS/PUSH_PAYOUT_BPS.
  public type ResolvedStatus = { #PlayerBlackjack; #PlayerBust; #DealerBust; #PlayerWin; #DealerWin; #Push };

  /// One player hand while a round is still #Open. status is null until
  /// this specific hand's outcome is knowable -- either it busted (known
  /// immediately) or it's done acting and just waiting on the dealer's
  /// result (only known once every hand is done -- see main.mo's
  /// dealerNeedsToPlay/finalizeWholeRound).
  public type PlayerHandView = { cards : [Card]; total : Nat; status : ?ResolvedStatus };

  /// One player hand once a round is #Resolved -- every hand has a final
  /// status/payout by then. betAmount is per-hand (doubled hands report
  /// their doubled size; split hands each report the original bet size).
  public type ResolvedPlayerHandView = { cards : [Card]; total : Nat; status : ResolvedStatus; betAmount : Nat; payoutAmount : Nat };

  /// A round-in-progress view never includes the dealer's real hidden hole
  /// card -- only dealerUpCard -- the same commit-before-reveal fairness
  /// principle spin() already applied (the old slots pull the stake before
  /// raw_rand ever resolves it); here it's "the deck is already shuffled
  /// and fixed the moment you see this view, but you're never shown the
  /// hidden card's value while it could still inform your hit/stand
  /// decision". See main.mo's Round type for the internal record that DOES
  /// hold it, and its own comment on why it must never be returned as-is.
  ///
  /// hands has length 1 normally, 2 after a split -- activeHandIndex says
  /// which one hit()/stand()/doubleDown() currently act on. canDouble/
  /// canSplit are computed server-side (see main.mo's viewOf) so the
  /// frontend never has to re-derive eligibility and risk a button that's
  /// enabled but errors on click.
  public type BlackjackView = {
    #Open : { hands : [PlayerHandView]; activeHandIndex : Nat; dealerUpCard : Card; canDouble : Bool; canSplit : Bool };
    #Resolved : { hands : [ResolvedPlayerHandView]; dealerCards : [Card]; dealerTotal : Nat; totalPayoutAmount : Nat };
  };

  public type BlackjackError = {
    #Anonymous;
    #TooSoon : { retryAfterNanos : Nat };
    #InvalidAmount;
    #BetTooLarge : { maxPayout : Nat };
    #TransferFailed : TransferFromError;
    #RandomnessFailed;
    #RoundAlreadyOpen;
    #NoOpenRound;
    #ActionNotAllowed; // doubleDown()/split() called when ineligible (wrong hand state, mismatched ranks for split) or while another action on this round is still in flight
  };

  public type BlackjackResult = { #Ok : BlackjackView; #Err : BlackjackError };

  /// claimPendingPayout's own result -- deliberately its own small type
  /// rather than force-fitting BlackjackView's #Resolved shape (which
  /// describes a finished hand, not "you got paid a stuck payout").
  public type ClaimResult = { #Ok : Nat; #Err : BlackjackError };

  public type RecentRound = {
    player : Principal;
    token : TokenKind;
    amount : Nat; // original per-hand bet size
    hands : [{ cards : [Card]; status : ResolvedStatus; payoutAmount : Nat }];
    dealerCards : [Card];
    timestamp : Time.Time;
  };

  /// Disclosed game rules, exposed read-only via getRules() -- same
  /// transparency role the old getPaytable() played for the slots. Unlike a
  /// slot's fixed-by-design RTP, blackjack's house edge depends on how well
  /// the player plays, so this discloses the rules themselves rather than a
  /// single RTP number.
  public type Rules = {
    deckCount : Nat;
    dealerStandsOn : Nat;
    blackjackPayoutBps : Nat;
    doubleDownAllowed : Bool;
    splitAllowed : Bool;
    resplitAllowed : Bool;
    doubleAfterSplitAllowed : Bool;
    insuranceOffered : Bool;
    roundExpiryNanos : Int;
  };

  /// Wagered volume, kept per-token rather than summed -- see dice's own
  /// LeaderboardEntry comment, same reasoning (PIKO has no established
  /// market value, so adding it to ICP wagered would mean nothing).
  public type LeaderboardEntry = { player : Principal; wageredIcpE8s : Nat; wageredPiko : Nat };

  /// Timelocked like dice's own RiskConfig -- named BankrollConfig here to
  /// describe what it actually protects, even though it plays the
  /// identical role dice's RiskConfig does.
  public type BankrollConfig = {
    maxPayoutBps : Nat;
    icpBankrollFloorE8s : Nat;
    cyclesFundRatioBps : Nat;
  };

  public type PendingBankrollConfig = { value : BankrollConfig; readyAt : Time.Time };

  public type PendingWithdrawal = {
    token : TokenKind;
    to : Principal;
    amount : Nat;
    readyAt : Time.Time;
  };

  public type PendingAdminChanges = {
    bankrollConfig : ?PendingBankrollConfig;
    withdrawal : ?PendingWithdrawal;
    timelockNanos : Int;
  };

  public type Config = {
    maxPayoutBps : Nat;
    icpBankrollFloorE8s : Nat;
    cyclesFundRatioBps : Nat;
    withdrawalsLocked : Bool;
    bankrollConfigLocked : Bool;
    icpLedgerId : Principal;
    pikoLedgerId : Principal;
    pikoLedgerLocked : Bool;
  };

  public type Stats = {
    roundsPlayed : Nat;
    totalWageredIcpE8s : Nat;
    totalWageredPiko : Nat;
    totalPaidOutIcpE8s : Nat;
    totalPaidOutPiko : Nat;
    icpBankrollE8s : Nat;
    pikoBankroll : Nat;
    cyclesBalance : Nat;
  };

  public type SweepResult = {
    profit : Nat;
    cyclesFunded : Nat;
    cyclesMinted : ?Nat;
    notifyError : ?Text;
  };
}
