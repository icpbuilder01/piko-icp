import { useCallback, useEffect, useState } from "react";
import { getMotherActor } from "./lib/actors";
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

const mother = getMotherActor();

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
          Chain <span className="section-icon">⛓️</span>
        </h2>
        <p className="section-intro">
          Everything on this page comes straight from permissionless query calls to
          `mother` -- no login, nothing cached server-side, nothing you couldn't verify
          yourself with <code>icp canister call</code>.
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
              <div className="stat-tile stat-tile-wide">
                <div className="stat-label">ICP burned, all-time</div>
                <div className="stat-value stat-value-small">{formatIcp(stats.totalIcpBurnedE8s)}</div>
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
            Recent blocks <span className="section-icon">🧱</span>
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
        Not shown: any individual miner's status (including the reference instance), or
        `frontend` and `ledger`'s own cycles balances -- the latter two don't expose a
        permissionless query for that, so this page doesn't guess.
        {lastUpdated !== null && <> Last updated {timeAgo(BigInt(lastUpdated) * 1_000_000n)}.</>}
      </p>
    </main>
  );
}

export default Dashboard;
