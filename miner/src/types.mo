module {
  /// Minimal interface for the `mother` canister, hand-written to match
  /// mother/mother.did (same rationale as mother's own hand-written Ledger
  /// interface: keeps each canister's build independent).
  public type Work = {
    height : Nat;
    previousHash : Blob;
    difficultyBits : Nat;
    reward : Nat;
    miningFeeE8s : Nat;
  };

  public type SubmitOk = { height : Nat; reward : Nat; hash : Blob };

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

  public type SubmitError = {
    #Anonymous;
    #InvalidProof;
    #TooSoon : { retryAfterNanos : Nat };
    #NothingToClaim;
    #IcpFeeFailed : TransferFromError;
    #StaleWork;
  };

  public type SubmitResult = { #Ok : SubmitOk; #Err : SubmitError };

  public type MotherActor = actor {
    getWork : () -> async Work;
    submitProof : (Nat) -> async SubmitResult;
  };

  /// Minimal ICRC-2 interface for the ICP ledger, used to let this canister
  /// approve `mother` to pull the mining fee from its own ICP balance.
  public type Account = { owner : Principal; subaccount : ?Blob };

  public type ApproveArgs = {
    fee : ?Nat;
    memo : ?Blob;
    from_subaccount : ?Blob;
    created_at_time : ?Nat64;
    amount : Nat;
    expected_allowance : ?Nat;
    expires_at : ?Nat64;
    spender : Account;
  };

  public type ApproveError = {
    #BadFee : { expected_fee : Nat };
    #InsufficientFunds : { balance : Nat };
    #AllowanceChanged : { current_allowance : Nat };
    #Expired : { ledger_time : Nat64 };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type ApproveResult = { #Ok : Nat; #Err : ApproveError };

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

  public type IcpLedgerActor = actor {
    icrc2_approve : (ApproveArgs) -> async ApproveResult;
    icrc1_balance_of : (Account) -> async Nat;
    icrc1_transfer : (TransferArg) -> async TransferResult;
  };

  public type Status = {
    mining : Bool;
    owner : Principal;
    motherId : Principal;
    attempts : Nat;
    blocksFound : Nat;
    nextNonce : Nat;
    batchSizePerTick : Nat;
    tickIntervalSeconds : Nat;
    feeCyclesPerSubmit : Nat;
    cyclesBalance : Nat;
    icpBalanceE8s : Nat;
    lastError : ?Text;
  };
}
