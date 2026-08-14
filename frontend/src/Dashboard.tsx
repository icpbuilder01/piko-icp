import { useCallback, useEffect, useState } from "react";
import { getMotherActor, getMinerActorAt } from "./lib/actors";
import { referenceMinerCanisterId } from "./lib/canister-env";
import { formatPiko, formatIcp, shortPrincipal, timeAgo } from "./lib/format";
import "./Dashboard.css";

const POLL_MS = 4000;

interface Stats {
  height: bigint;
  totalMinted: bigint;
  maxSupply: bigint;
  difficultyBits: bigint;
  currentReward: bigint;
  nextHalvingHeight: bigint;
  miningFeeE8s: bigint;
  retargetIntervalBlocks: bigint;
  targetBlockTimeNanos: bigint;
  blocksUntilRetarget: bigint;
  lastRetargetAt: bigint;
  totalIcpBurnedE8s: bigint;
}

interface Block {
  height: bigint;
  miner: { toText(): string };
  reward: bigint;
  timestamp: bigint;
}

interface MinerStatus {
  mining: boolean;
  attempts: bigint;
  blocksFound: bigint;
  cyclesBalance: bigint;
  icpBalanceE8s: bigint;
  lastError?: string;
}

const mother = getMotherActor();
const referenceMiner = referenceMinerCanisterId ? getMinerActorAt(referenceMinerCanisterId) : null;

function formatCycles(raw: bigint): string {
  const t = Number(raw) / 1e12;
  return `${t.toFixed(2)}T`;
}

function formatBlockTime(nanos: bigint): string {
  const seconds = Number(nanos) / 1e9;
  if (seconds < 120) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)} min`;
}

function Meter({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "spark" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="meter-track">
      <div className={`meter-fill meter-fill-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [motherCycles, setMotherCycles] = useState<bigint | null>(null);
  const [minerStatus, setMinerStatus] = useState<MinerStatus | null>(null);
  const [minerError, setMinerError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, b, c] = await Promise.all([
        mother.getStats(),
        mother.getRecentBlocks(),
        mother.cyclesBalance(),
      ]);
      setStats(s as unknown as Stats);
      setBlocks((b as unknown as Block[]).slice().reverse());
      setMotherCycles(c);
    } catch (err) {
      console.error("Failed to refresh mother stats", err);
    }

    if (referenceMiner) {
      try {
        const status = await referenceMiner.getStatus();
        setMinerStatus(status as unknown as MinerStatus);
        setMinerError(null);
      } catch (err) {
        console.error("Failed to refresh reference miner status", err);
        setMinerError("Reference miner is unreachable right now.");
      }
    }

    setLastUpdated(Date.now());
  }, []);

  useEffect(() => {
    // Polling on-chain state is "subscribing to an external system" -- the
    // documented valid use of setState-in-effect, not derived local state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const supplyPct = stats ? Number((stats.totalMinted * 10000n) / (stats.maxSupply || 1n)) / 100 : 0;
  const retargetDone = stats ? Number(stats.retargetIntervalBlocks - stats.blocksUntilRetarget) : 0;
  const retargetTotal = stats ? Number(stats.retargetIntervalBlocks) : 10;

  return (
    <main className="page dashboard-page">
      <header className="header">
        <div className="brand">
          <img src="/piko-logo.svg" alt="" className="brand-logo" />
          <div className="brand-text">
            <span className="brand-name">PIKO Dashboard</span>
            <span className="brand-ticker">
              {stats ? (
                <>
                  <span className="pulse-dot" /> Block #{stats.height.toLocaleString()} live
                </>
              ) : (
                "Loading on-chain state..."
              )}
            </span>
          </div>
        </div>
        <a className="button secondary" href="/">
          &larr; Main site
        </a>
      </header>

      <section className="block">
        <h2>
          <span className="section-icon">#</span>Chain
        </h2>
        <p className="section-intro">
          Everything on this page comes straight from permissionless query calls to
          `mother` and the reference `miner` -- no login, nothing cached server-side, nothing
          you couldn't verify yourself with <code>icp canister call</code>.
        </p>
        {stats ? (
          <>
            <div className="hero-figure-row">
              <div>
                <div className="hero-figure-label">Chain height</div>
                <div className="hero-figure">{stats.height.toLocaleString()}</div>
              </div>
              <div>
                <div className="hero-figure-label">Current block reward</div>
                <div className="hero-figure hero-figure-sub">{formatPiko(stats.currentReward)} PIKO</div>
              </div>
            </div>

            <div className="stat-grid">
              <div className="stat-tile">
                <div className="stat-label">Difficulty</div>
                <div className="stat-value">{stats.difficultyBits.toString()} bits</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Mining fee</div>
                <div className="stat-value">{formatIcp(stats.miningFeeE8s)} ICP</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Retarget target</div>
                <div className="stat-value">{formatBlockTime(stats.targetBlockTimeNanos)}/block</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Last retarget</div>
                <div className="stat-value stat-value-small">{timeAgo(stats.lastRetargetAt)}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Next halving</div>
                <div className="stat-value stat-value-small">block {stats.nextHalvingHeight.toLocaleString()}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">mother's cycles</div>
                <div className="stat-value">{motherCycles !== null ? formatCycles(motherCycles) : "..."}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">ICP burned, all-time</div>
                <div className="stat-value">{formatIcp(stats.totalIcpBurnedE8s)}</div>
              </div>
            </div>

            <div className="meter-block">
              <div className="meter-caption">
                <span>Supply minted</span>
                <span>
                  {formatPiko(stats.totalMinted)} / {formatPiko(stats.maxSupply)} PIKO ({supplyPct.toFixed(2)}%)
                </span>
              </div>
              <Meter value={supplyPct} max={100} tone="accent" />
            </div>

            <div className="meter-block">
              <div className="meter-caption">
                <span>Blocks until next retarget</span>
                <span>
                  {retargetDone}/{retargetTotal}
                </span>
              </div>
              <Meter value={retargetDone} max={retargetTotal} tone="spark" />
            </div>
          </>
        ) : (
          <div className="empty-state">Loading chain status...</div>
        )}
      </section>

      <section className="block">
        <div className="miner-panel-head">
          <h2 className="spark">
            <span className="section-icon">&#9878;</span>Reference miner
          </h2>
          {minerStatus && (
            <span className={`status-pill ${minerStatus.mining ? "status-good" : "status-critical"}`}>
              <span className="status-dot" />
              {minerStatus.mining ? "mining" : "stopped"}
            </span>
          )}
        </div>
        {referenceMinerCanisterId ? (
          minerStatus ? (
            <>
              <div className="stat-grid">
                <div className="stat-tile">
                  <div className="stat-label">Attempts (this run)</div>
                  <div className="stat-value">{minerStatus.attempts.toLocaleString()}</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-label">Blocks found</div>
                  <div className="stat-value">{minerStatus.blocksFound.toString()}</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-label">Cycles</div>
                  <div className="stat-value">{formatCycles(minerStatus.cyclesBalance)}</div>
                </div>
                <div className="stat-tile">
                  <div className="stat-label">ICP balance</div>
                  <div className="stat-value">{formatIcp(minerStatus.icpBalanceE8s)}</div>
                </div>
              </div>
              {minerStatus.lastError && (
                <p className="miner-error-note">&#9888; {minerStatus.lastError}</p>
              )}
            </>
          ) : (
            <div className="empty-state">{minerError ?? "Loading reference miner status..."}</div>
          )
        ) : (
          <div className="empty-state">
            No reference miner is configured for this deployment.
          </div>
        )}
      </section>

      <section className="block">
        <div className="miner-panel-head">
          <h2 className="spark">
            <span className="section-icon">&#9638;</span>Recent blocks
          </h2>
          {blocks.length > 0 && (
            <span className="live-pill">
              <span className="live-dot" /> live feed
            </span>
          )}
        </div>
        {blocks.length > 0 ? (
          <table className="blocks">
            <thead>
              <tr>
                <th>Height</th>
                <th>Miner</th>
                <th>Reward</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.height.toString()}>
                  <td>{b.height.toString()}</td>
                  <td className="mono">{shortPrincipal(b.miner.toText())}</td>
                  <td>{formatPiko(b.reward)}</td>
                  <td>{timeAgo(b.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No blocks mined yet.</div>
        )}
      </section>

      <p className="dashboard-footnote">
        Not shown: `frontend` and `ledger` canisters' own cycles balances -- neither
        exposes a permissionless query for that, so this page doesn't guess.
        {lastUpdated !== null && <> Last updated {timeAgo(BigInt(lastUpdated) * 1_000_000n)}.</>}
      </p>
    </main>
  );
}

export default Dashboard;
