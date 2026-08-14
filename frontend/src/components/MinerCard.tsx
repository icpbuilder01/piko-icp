import { useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { getMinerActorAt } from "../lib/actors";
import { fundMinerIcp, finishMinerSetup } from "../lib/deployMiner";
import { formatAmount, parseAmount, shortPrincipal } from "../lib/format";

interface Status {
  mining: boolean;
  attempts: bigint;
  blocksFound: bigint;
  cyclesBalance: bigint;
  icpBalanceE8s: bigint;
  lastError?: string;
}

const STATUS_POLL_MS = 10000;

interface MinerCardProps {
  canisterId: string;
  identity: Identity;
  onForget: () => void;
}

// One tracked miner's live status, plus the two recovery actions a
// partially-set-up (or simply low-on-funds) miner actually needs: send it
// more ICP, and (re-)finish approveIcpFee()+start(). Both are safe to call
// repeatedly -- approveIcpFee just resets the allowance, start() is a
// no-op if it's already mining.
export function MinerCard({ canisterId, identity, onForget }: MinerCardProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState("0.1");
  const [busy, setBusy] = useState<"topup" | "finish" | null>(null);
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
        <button type="button" className="button secondary small" onClick={onForget}>
          Forget
        </button>
      </div>

      {statusError && <p className="deploy-miner-error">{statusError}</p>}

      {status && (
        <div className="miner-card-stats">
          <span>{status.blocksFound.toString()} blocks found</span>
          <span>{status.attempts.toLocaleString()} attempts</span>
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
      {actionError && <p className="deploy-miner-error">{actionError}</p>}
      {actionMessage && <p className="deploy-miner-status">{actionMessage}</p>}
    </div>
  );
}
