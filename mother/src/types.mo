import Time "mo:core/Time";

module {
  /// Minimal ICRC-1 interface for the pre-built `ledger` canister.
  /// Hand-written (rather than `import "canister:ledger"`) because ledger is a
  /// pre-built external canister, not a Motoko source compiled in this project --
  /// the standard pattern for calling system/external canisters from Motoko.
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

  public type LedgerActor = actor {
    icrc1_transfer : (TransferArg) -> async TransferResult;
    icrc1_balance_of : (Account) -> async Nat;
  };

  /// ICRC-2 subset of the ICP ledger's interface, used to pull (and burn) the
  /// mining fee from a miner's own ICP balance. The miner must have called
  /// `icrc2_approve` on the ICP ledger first (done from the frontend before
  /// mining starts).
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

  public type IcpLedgerActor = actor {
    icrc2_transfer_from : (TransferFromArgs) -> async TransferFromResult;
    icrc1_transfer : (TransferArg) -> async TransferResult;
    icrc1_balance_of : (Account) -> async Nat;
  };

  /// Minimal Cycles Minting Canister (CMC) interface, used to convert this
  /// canister's own ICP holdings into cycles (see sweepTreasury() in
  /// main.mo). Mainnet CMC: rkp4c-7iaaa-aaaaa-aaaca-cai.
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

  /// The IC management canister (aaaaa-aa) -- used by topUpProject() in
  /// main.mo to share mother's own cycles surplus with frontend/miner,
  /// neither of which has any other way to earn cycles. deposit_cycles
  /// credits whatever cycles are attached to *this* call to canister_id;
  /// unlike notify_top_up, no ICP/CMC round-trip is involved, since these
  /// are cycles mother already has.
  public type ManagementActor = actor {
    deposit_cycles : ({ canister_id : Principal }) -> async ();
  };

  /// Result of one sweepTreasury() call -- see main.mo for why this is
  /// stateless (every field is derived fresh from the live ICP balance,
  /// nothing here is a running counter that could drift).
  public type SweepResult = {
    swept : Nat;
    burned : Nat;
    cyclesFunded : Nat;
    cyclesMinted : ?Nat;
    notifyError : ?Text;
  };

  /// A queued, not-yet-applied admin change -- see ADMIN_TIMELOCK_NANOS in
  /// main.mo. readyAt is when executeCyclesFundRatioBps()/executeIcpFeeTarget()
  /// are allowed to apply it.
  public type PendingNatChange = { value : Nat; readyAt : Time.Time };

  public type PendingIcpFeeTarget = {
    ledgerId : Principal;
    burnOwner : Principal;
    cmcId : Principal;
    readyAt : Time.Time;
  };

  public type PendingAdminChanges = {
    cyclesFundRatio : ?PendingNatChange;
    icpFeeTarget : ?PendingIcpFeeTarget;
    timelockNanos : Int;
  };

  /// Work miners must hash against to produce a valid proof.
  public type Work = {
    height : Nat;
    previousHash : Blob;
    difficultyBits : Nat;
    reward : Nat;
    miningFeeE8s : Nat;
  };

  public type Block = {
    height : Nat;
    miner : Principal;
    reward : Nat;
    hash : Blob;
    timestamp : Time.Time;
  };

  public type SubmitOk = { height : Nat; reward : Nat; hash : Blob };

  public type SubmitError = {
    #Anonymous;
    #InvalidProof;
    #TooSoon : { retryAfterNanos : Nat };
    #NothingToClaim;
    #IcpFeeFailed : TransferFromError;
    #StaleWork;
  };

  public type SubmitResult = { #Ok : SubmitOk; #Err : SubmitError };

  public type LeaderboardEntry = { miner : Principal; blocksFound : Nat; totalReward : Nat };

  public type Stats = {
    height : Nat;
    totalMinted : Nat;
    maxSupply : Nat;
    difficultyBits : Nat;
    currentReward : Nat;
    nextHalvingHeight : Nat;
    ledgerId : Principal;
    miningFeeE8s : Nat;
    icpLedgerId : Principal;
    icpBurnOwner : Principal;
    icpFeeTargetLocked : Bool;
    cmcId : Principal;
    cyclesFundRatioBps : Nat;
    cyclesFundRatioLocked : Bool;
    /// Automatic difficulty retargeting -- see main.mo. Blocks per retarget
    /// window, the target time per block that window is aiming for, how
    /// many blocks remain until the next retarget, and when difficulty last
    /// changed.
    retargetIntervalBlocks : Nat;
    targetBlockTimeNanos : Nat;
    blocksUntilRetarget : Nat;
    lastRetargetAt : Time.Time;
  };
}
