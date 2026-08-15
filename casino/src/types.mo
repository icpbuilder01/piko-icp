import Time "mo:core/Time";

module {
  /// Same minimal ICRC-1/ICRC-2 interface mother/src/types.mo declares for
  /// the ICP ledger -- duplicated here rather than imported cross-canister
  /// (this project's existing convention: each canister owns its own
  /// types.mo, see mother/miner). Used for both the ICP ledger and PIKO's
  /// own ledger, since both are ICRC-1/ICRC-2 and expose the same shape.
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
  /// cycles, exactly like mother's sweepTreasury(). Mainnet CMC:
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

  /// The IC management canister (aaaaa-aa). raw_rand is what resolves every
  /// bet -- see placeBet() in main.mo for why it's only ever called *after*
  /// the stake has already been pulled from the player.
  public type ManagementActor = actor {
    raw_rand : () -> async Blob;
  };

  /// Which ledger a bet is denominated in. BOB is deliberately not
  /// supported -- see README's non-affiliation note for why hosting a
  /// betting market on a token this project doesn't control was ruled out.
  public type TokenKind = { #ICP; #PIKO };

  public type BetOk = { roll : Nat; won : Bool; payoutAmount : Nat };

  public type BetError = {
    #Anonymous;
    #InvalidTarget;
    #InvalidAmount;
    #BetInProgress;
    #BetTooLarge : { maxPayout : Nat };
    #TransferFailed : TransferFromError;
    #RandomnessFailed;
  };

  public type BetResult = { #Ok : BetOk; #Err : BetError };

  public type RecentBet = {
    player : Principal;
    token : TokenKind;
    amount : Nat;
    target : Nat;
    roll : Nat;
    won : Bool;
    payoutAmount : Nat;
    timestamp : Time.Time;
  };

  // Wagered volume, kept per-token rather than summed into one figure --
  // PIKO has no established market value (see README) so adding it to ICP
  // wagered would produce a number that means nothing economically. Sorted
  // by PIKO volume (see getLeaderboard() in main.mo) -- the casino-frontend/
  // site only ever offers PIKO bets, so that's the only volume that's
  // actually meaningful to rank players by; wageredIcpE8s is still tracked
  // for whoever bets ICP directly against the canister.
  public type LeaderboardEntry = { player : Principal; wageredIcpE8s : Nat; wageredPiko : Nat };

  /// Timelocked like mother's cyclesFundRatio/icpFeeTarget: everything here
  /// either protects players' odds of getting paid (maxPayoutBps,
  /// icpBankrollFloorE8s) or the "X% becomes cycles" promise
  /// (cyclesFundRatioBps) -- bundled into one proposal so there's one
  /// propose/execute/cancel/lock trio instead of three, since all three
  /// exist for the same reason (protect the bankroll) and are meant to be
  /// tuned together as real betting volume comes in.
  public type RiskConfig = {
    maxPayoutBps : Nat;
    icpBankrollFloorE8s : Nat;
    cyclesFundRatioBps : Nat;
  };

  public type PendingRiskConfig = { value : RiskConfig; readyAt : Time.Time };

  /// A queued, timelocked withdrawal of the controller's own seeded
  /// bankroll -- see withdrawBankroll()/lockWithdrawals() in main.mo. Unlike
  /// RiskConfig, this is a one-shot action, not a standing parameter, so it
  /// clears itself once executed rather than persisting as a new value.
  public type PendingWithdrawal = {
    token : TokenKind;
    to : Principal;
    amount : Nat;
    readyAt : Time.Time;
  };

  public type PendingAdminChanges = {
    riskConfig : ?PendingRiskConfig;
    withdrawal : ?PendingWithdrawal;
    timelockNanos : Int;
  };

  public type Config = {
    minTarget : Nat;
    maxTarget : Nat;
    payoutNumerator : Nat; // payout = amount * payoutNumerator / target -- fixed, never admin-settable
    maxPayoutBps : Nat;
    icpBankrollFloorE8s : Nat;
    cyclesFundRatioBps : Nat;
    withdrawalsLocked : Bool;
    icpLedgerId : Principal;
    pikoLedgerId : Principal;
  };

  public type Stats = {
    betsPlaced : Nat;
    betsWon : Nat;
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
