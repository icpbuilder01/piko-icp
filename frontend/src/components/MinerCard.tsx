import { useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getMinerActorAt } from "../lib/actors";
import { fundMinerIcp, finishMinerSetup, updateMinerCode } from "../lib/deployMiner";
import { formatAmount, parseAmount, shortPrincipal } from "../lib/format";

interface Status {
  mining: boolean;
  attempts: bigint;
  blocksFound: bigint;
  cyclesBalance: bigint;
  icpBalanceE8s: bigint;
  pikoBalance: bigint;
  lastError?: string;
}

const STATUS_POLL_MS = 10000;
const PIKO_LEDGER_FEE = 10_000n; // matches ledger/icrc1_ledger_init.args -- same magnitude as the ICP ledger's, unrelated value

interface MinerCardProps {
  canisterId: string;
  identity: Identity;
  onForget: () => void;
}

type Busy = "topup" | "finish" | "stop" | "withdraw" | "update" | null;

// One tracked miner's live status, plus the actions a deployed miner
// actually needs from here: top up ICP, (re-)finish approveIcpFee()+start(),
// pause it, withdraw the PIKO it's won (see withdrawPiko's own comment in
// miner/src/main.mo -- a block win mints to the *canister's* principal, not
// the owner's, so this is the only way that PIKO ever reaches a wallet),
// and update its code (the only way an already-deployed miner can ever pick
// up a fix shipped after it was created, since this project doesn't control
// it -- the deploying owner is the sole controller).
export function MinerCard({ canisterId, identity, onForget }: MinerCardProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState("0.1");
  const [withdrawTo, setWithdrawTo] = useState(() => identity.getPrincipal().toText());
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  async function refreshStatus() {
    try {
      const miner = getMinerActorAt(canisterId, identity);
      const s = await miner.getStatus();
      setStatus(s as unknown as Status);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to load status.");
    }
  }

  useEffect(() => {
    // Polling the miner canister is "subscribing to an external system", the
    // documented valid use of setState-in-effect -- not derived local state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshStatus();
    const id = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canisterId/identity are the actual dependencies; refreshStatus is recreated every render but always closes over the same values
  }, [canisterId, identity]);

  // Pre-fill the withdraw field with everything currently on hand (minus
  // the ledger's own transfer fee, or the transfer itself fails with
  // InsufficientFunds even though the balance looks like "enough") once the
  // balance is known -- but only until the user types their own amount.
  const [withdrawTouched, setWithdrawTouched] = useState(false);
  useEffect(() => {
    if (withdrawTouched || !status || status.pikoBalance <= PIKO_LEDGER_FEE) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deriving from status, which arrives asynchronously from the canister, not from local/derived state
    setWithdrawAmount(formatAmount(status.pikoBalance - PIKO_LEDGER_FEE));
  }, [status, withdrawTouched]);

  async function handleTopUp() {
    const amount = parseAmount(topUpAmount);
    if (amount === null || amount <= 0n) {
      setActionError("Enter a valid ICP amount.");
      return;
    }
    setBusy("topup");
    setActionError(null);
    setActionMessage(null);
    try {
      await fundMinerIcp(identity, canisterId, amount);
      setActionMessage(`Sent ${formatAmount(amount)} ICP.`);
      await refreshStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Sending ICP failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleFinishSetup() {
    if (!status) return;
    setBusy("finish");
    setActionError(null);
    setActionMessage(null);
    try {
      await finishMinerSetup(identity, canisterId, status.icpBalanceE8s);
      setActionMessage("Approved and started.");
      await refreshStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Finishing setup failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handlePause() {
    setBusy("stop");
    setActionError(null);
    setActionMessage(null);
    try {
      await getMinerActorAt(canisterId, identity).stop();
      setActionMessage("Paused.");
      await refreshStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Pausing failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleWithdraw() {
    const amount = parseAmount(withdrawAmount);
    if (amount === null || amount <= 0n) {
      setActionError("Enter a valid PIKO amount.");
      return;
    }
    let to: Principal;
    try {
      to = Principal.fromText(withdrawTo.trim());
    } catch {
      setActionError("That doesn't look like a valid principal.");
      return;
    }
    setBusy("withdraw");
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await getMinerActorAt(canisterId, identity).withdrawPiko(to, amount);
      if (result.__kind__ !== "Ok") {
        throw new Error(JSON.stringify(result.Err, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      }
      setActionMessage(`Sent ${formatAmount(amount)} PIKO.`);
      setWithdrawTouched(false);
      await refreshStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Withdrawing PIKO failed.");
    } finally {
      setBusy(null);
    }
  }

  async function handleUpdateCode() {
    setBusy("update");
    setActionError(null);
    setActionMessage(null);
    try {
      await updateMinerCode(identity, canisterId);
      setActionMessage("Code updated -- state (balances, mining status) preserved.");
      await refreshStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Updating code failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="miner-card">
      <div className="miner-card-head">
        <code className="miner-card-id" title={canisterId}>
          {shortPrincipal(canisterId)}
        </code>
        {status && (
          <span className={`status-pill ${status.mining ? "status-good" : "status-critical"}`}>
            <span className="status-dot" />
            {status.mining ? "mining" : "stopped"}
          </span>
        )}
        {status?.mining && (
          <button type="button" className="button secondary small" onClick={handlePause} disabled={busy !== null}>
            {busy === "stop" ? "Pausing..." : "Pause"}
          </button>
        )}
        <button type="button" className="button secondary small" onClick={handleUpdateCode} disabled={busy !== null}>
          {busy === "update" ? "Updating..." : "Update code"}
        </button>
        <button type="button" className="button secondary small" onClick={onForget}>
          Forget
        </button>
      </div>

      {statusError && <p className="deploy-miner-error">{statusError}</p>}

      {status && (
        <div className="miner-card-stats">
          <span>{status.blocksFound.toString()} blocks found</span>
          <span>{status.attempts.toLocaleString()} attempts</span>
          <span>{formatAmount(status.pikoBalance)} PIKO</span>
          <span>{formatAmount(status.icpBalanceE8s)} ICP</span>
          <span>{(Number(status.cyclesBalance) / 1e12).toFixed(2)}T cycles</span>
        </div>
      )}
      {status?.lastError && <p className="deploy-miner-error">{status.lastError}</p>}

      <div className="deploy-miner-row">
        <label className="deploy-miner-field">
          <span className="stat-label">Send it ICP</span>
          <input
            className="input"
            value={topUpAmount}
            onChange={(e) => setTopUpAmount(e.target.value)}
            inputMode="decimal"
            disabled={busy !== null}
          />
        </label>
        <button className="button secondary" onClick={handleTopUp} disabled={busy !== null}>
          {busy === "topup" ? "Sending..." : "Top up"}
        </button>
        {status && !status.mining && (
          <button className="button button-cta" onClick={handleFinishSetup} disabled={busy !== null}>
            {busy === "finish" ? "Starting..." : "Approve + start"}
          </button>
        )}
      </div>

      {status && status.pikoBalance > 0n && (
        <div className="deploy-miner-row">
          <label className="deploy-miner-field">
            <span className="stat-label">Withdraw PIKO to</span>
            <input
              className="input"
              value={withdrawTo}
              onChange={(e) => setWithdrawTo(e.target.value)}
              disabled={busy !== null}
            />
          </label>
          <label className="deploy-miner-field">
            <span className="stat-label">Amount</span>
            <input
              className="input"
              value={withdrawAmount}
              onChange={(e) => {
                setWithdrawTouched(true);
                setWithdrawAmount(e.target.value);
              }}
              inputMode="decimal"
              disabled={busy !== null}
            />
          </label>
          <button className="button button-cta" onClick={handleWithdraw} disabled={busy !== null}>
            {busy === "withdraw" ? "Sending..." : "Withdraw"}
          </button>
        </div>
      )}
      {actionError && <p className="deploy-miner-error">{actionError}</p>}
      {actionMessage && <p className="deploy-miner-status">{actionMessage}</p>}
    </div>
  );
}
