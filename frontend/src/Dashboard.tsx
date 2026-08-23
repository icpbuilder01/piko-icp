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
  totalIcpFeesCollectedE8s: bigint;
  totalIcpConvertedToCyclesE8s: bigint;
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

// Network hashrate isn't a value `mother` tracks (or could -- it only ever
// sees the winning nonce, never how many were tried) -- this is the same
// inference every PoW explorer makes: expected attempts to clear N leading
// zero bits is 2^N, so attempts/second is that over the observed time per
// block. Averaged over the blocks found since the last retarget specifically
// (not the raw recent-blocks buffer), so a difficulty change mid-window
// never mixes an old and new difficulty into one estimate.
function estimateHashrate(difficultyBits: bigint, blocksSinceRetarget: number, lastRetargetAtNanos: bigint): number | null {
  const secondsSinceRetarget = (Date.now() - Number(lastRetargetAtNanos / 1_000_000n)) / 1000;
  if (blocksSinceRetarget <= 0 || secondsSinceRetarget <= 0) return null;
  const avgSecondsPerBlock = secondsSinceRetarget / blocksSinceRetarget;
  return 2 ** Number(difficultyBits) / avgSecondsPerBlock;
}

function formatHashrate(hashesPerSecond: number | null): string {
  if (hashesPerSecond === null || !isFinite(hashesPerSecond)) return "not enough data yet";
  const units = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s"];
  let value = hashesPerSecond;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return `~${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
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
  const [minerCount, setMinerCount] = useState<bigint | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, b, c, m] = await Promise.all([
        mother.getStats(),
        mother.getRecentBlocks(),
        mother.cyclesBalance(),
        mother.getMinerCount(),
      ]);
      setStats(s as unknown as Stats);
      setBlocks((b as unknown as Block[]).slice().reverse());
      setMotherCycles(c);
      setMinerCount(m);
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
  const hashrate = stats ? estimateHashrate(stats.difficultyBits, retargetDone, stats.lastRetargetAt) : null;

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
              <div>
                <div className="hero-figure-label">Miners who've found a block</div>
                <div className="hero-figure hero-figure-sub">
                  {minerCount !== null ? minerCount.toLocaleString() : "..."}
                </div>
              </div>
              <div>
                <div className="hero-figure-label">Last block</div>
                <div className="hero-figure hero-figure-sub">
                  {blocks.length > 0 ? timeAgo(blocks[0].timestamp) : "..."}
                </div>
              </div>
            </div>

            <div className="stat-grid">
              <div className="stat-tile">
                <div className="stat-label">Difficulty</div>
                <div className="stat-value">{stats.difficultyBits.toString()} bits</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Est. network hashrate</div>
                <div className="stat-value stat-value-small">{formatHashrate(hashrate)}</div>
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
                <div className="stat-label">ICP spent mining, all-time (real-time)</div>
                <div className="stat-value stat-value-small">{formatIcp(stats.totalIcpFeesCollectedE8s)}</div>
              </div>
              <div className="stat-tile stat-tile-wide">
                <div className="stat-label">ICP burned, all-time (confirmed, updates every sweep)</div>
                <div className="stat-value stat-value-small">{formatIcp(stats.totalIcpBurnedE8s)}</div>
              </div>
              <div className="stat-tile stat-tile-wide">
                <div className="stat-label">ICP converted to cycles, all-time (funds this project, not a bug)</div>
                <div className="stat-value stat-value-small">
                  {formatIcp(stats.totalIcpConvertedToCyclesE8s)}
                </div>
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
          <div className="table-scroll">
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
          </div>
        ) : (
          <div className="empty-state">No blocks mined yet.</div>
        )}
      </section>

      <p className="dashboard-footnote">
        Est. network hashrate is inferred, not measured -- `mother` only ever sees the
        winning nonce, never how many were tried, so this is 2^difficulty over the average
        time per block since the last retarget (nothing to infer it from before that).
        Not shown: any individual miner's status (including the reference instance), or
        `frontend` and `ledger`'s own cycles balances -- the latter two don't expose a
        permissionless query for that, so this page doesn't guess.
        {lastUpdated !== null && <> Last updated {timeAgo(BigInt(lastUpdated) * 1_000_000n)}.</>}
      </p>
    </main>
  );
}

export default Dashboard;
