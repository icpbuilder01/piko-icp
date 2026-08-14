import { useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { deployMiner, type DeployProgress } from "../lib/deployMiner";
import { parseAmount, formatAmount } from "../lib/format";

interface DeployMinerProps {
  identity: Identity;
  // Current live mining fee (e8s) -- used to size the default funding
  // amount. 0n while chain stats haven't loaded yet.
  miningFeeE8s: bigint;
}

const DEFAULT_CYCLES_ICP = "0.3";
// How many blocks' worth of the *current* mining fee to pre-fill the
// funding field with. A dedicated miner is meant to run unattended for a
// while -- defaulting to "one block" (an earlier version of this
// component did, hardcoded at "0.5") meant it could stop after its very
// first attempt.
const DEFAULT_FUND_BLOCKS = 10n;

const STEP_LABELS: Record<DeployProgress["step"], string> = {
  paying: "1/6 Paying the Cycles Minting Canister",
  creating: "2/6 Creating your canister",
  installing: "3/6 Installing the miner",
  funding: "4/6 Funding it with ICP",
  approving: "5/6 Approving the mining fee",
  starting: "6/6 Starting it mining",
  done: "Done",
};

export function DeployMiner({ identity, miningFeeE8s }: DeployMinerProps) {
  const [cyclesIcp, setCyclesIcp] = useState(DEFAULT_CYCLES_ICP);
  const [fundIcp, setFundIcp] = useState("");
  const [fundTouched, setFundTouched] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<DeployProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canisterId, setCanisterId] = useState<string | null>(null);

  // Fill the funding field with DEFAULT_FUND_BLOCKS worth of the real,
  // live mining fee once it's known -- but only if the user hasn't typed
  // their own amount in already.
  useEffect(() => {
    if (!fundTouched && miningFeeE8s > 0n) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deriving from a prop that arrives asynchronously (chain stats), not from local/derived state
      setFundIcp(formatAmount(miningFeeE8s * DEFAULT_FUND_BLOCKS));
    }
  }, [miningFeeE8s, fundTouched]);

  async function handleDeploy() {
    const cyclesAmount = parseAmount(cyclesIcp);
    const fundAmount = parseAmount(fundIcp);
    if (cyclesAmount === null || cyclesAmount <= 0n) {
      setError("Enter a valid ICP amount for cycles.");
      return;
    }
    if (fundAmount === null || fundAmount <= 0n) {
      setError("Enter a valid ICP amount to fund mining.");
      return;
    }

    setRunning(true);
    setError(null);
    setCanisterId(null);
    setProgress(null);
    try {
      const result = await deployMiner(identity, cyclesAmount, fundAmount, setProgress);
      setCanisterId(result.canisterId);
    } catch (err) {
      console.error("deployMiner failed", err);
      setError(err instanceof Error ? err.message : "Deploy failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="deploy-miner">
      {canisterId ? (
        <div className="deploy-miner-done">
          <p>
            <strong>It's mining.</strong> Canister <code>{canisterId}</code> is now yours, running
            on its own timer -- close this tab, it keeps going until the ICP you sent it runs out.
          </p>
        </div>
      ) : (
        <>
          <p className="section-intro">
            Two unrelated things, both paid in ICP up front: one becomes{" "}
            <strong>cycles</strong> — the canister's own electricity bill, nothing to do
            with mining. The other stays <strong>ICP</strong>, sitting in the canister's
            own wallet, spent exactly like your wallet would be:{" "}
            {miningFeeE8s > 0n ? `${formatAmount(miningFeeE8s)} ICP` : "the fee"} per
            submission, win or lose.
          </p>
          <div className="deploy-miner-row">
            <label className="deploy-miner-field">
              <span className="stat-label">ICP &rarr; cycles (runs the canister)</span>
              <input
                className="input"
                value={cyclesIcp}
                onChange={(e) => setCyclesIcp(e.target.value)}
                inputMode="decimal"
                disabled={running}
              />
            </label>
            <label className="deploy-miner-field">
              <span className="stat-label">ICP &rarr; mining fees (stays as ICP)</span>
              <input
                className="input"
                value={fundIcp}
                onChange={(e) => {
                  setFundTouched(true);
                  setFundIcp(e.target.value);
                }}
                inputMode="decimal"
                disabled={running}
              />
            </label>
          </div>
          <button className="button button-cta" onClick={handleDeploy} disabled={running}>
            {running ? "Deploying..." : "Deploy my miner"}
          </button>
          {progress && (
            <p className="deploy-miner-status">
              {STEP_LABELS[progress.step]} -- {progress.message}
            </p>
          )}
          {error && <p className="deploy-miner-error">{error}</p>}
          <p className="wallet-hint">
            The mining-fee field defaults to {DEFAULT_FUND_BLOCKS} submissions' worth at
            the current fee. This sends real ICP right away -- you'll be the new
            canister's sole controller.
          </p>
        </>
      )}
    </div>
  );
}
