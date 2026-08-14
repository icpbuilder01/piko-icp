import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getMotherActor, getLedgerActor, getIcpLedgerActor } from "./lib/actors";
import { login, logout, getStoredIdentity } from "./lib/auth";
import { motherCanisterId, ledgerCanisterId } from "./lib/canister-env";
import { formatPiko, formatIcp, shortPrincipal, timeAgo } from "./lib/format";
import { Wallet } from "./components/Wallet";
import { Confetti } from "./components/Confetti";
import "./App.css";

const POLL_MS = 5000;
// How many blocks' worth of mining fee to approve at once. Kept small (a
// couple blocks) now that the fee is a meaningful amount of real ICP --
// approving 50 blocks' worth at once would mean committing a lot of money
// in one popup.
const APPROVE_BLOCKS = 3;

interface Stats {
  height: bigint;
  totalMinted: bigint;
  maxSupply: bigint;
  difficultyBits: bigint;
  currentReward: bigint;
  nextHalvingHeight: bigint;
  ledgerId: { toText(): string };
  miningFeeE8s: bigint;
  icpLedgerId: { toText(): string };
}

interface Block {
  height: bigint;
  miner: { toText(): string };
  reward: bigint;
  hash: Uint8Array | number[];
  timestamp: bigint;
}

interface Work {
  height: bigint;
  previousHash: Uint8Array | number[];
  difficultyBits: bigint;
  reward: bigint;
  miningFeeE8s: bigint;
}

interface LeaderboardEntry {
  miner: { toText(): string };
  blocksFound: bigint;
  totalReward: bigint;
}

type SubmitResult =
  | { Ok: { height: bigint; reward: bigint; hash: Uint8Array | number[] } }
  | { Err: Record<string, unknown> };

const anonymousMother = getMotherActor();
const motherPrincipal = Principal.fromText(motherCanisterId);

function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [work, setWork] = useState<Work | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

  const [mining, setMining] = useState(false);
  const [hashrate, setHashrate] = useState(0);
  const [sessionAttempts, setSessionAttempts] = useState(0);
  const [sessionBlocks, setSessionBlocks] = useState(0);
  const [miningMessage, setMiningMessage] = useState<string | null>(null);
  const [lastWinReward, setLastWinReward] = useState<bigint | null>(null);
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const [copiedLedger, setCopiedLedger] = useState(false);

  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [approving, setApproving] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const identityRef = useRef<Identity | null>(null);
  const miningRef = useRef(false);
  identityRef.current = identity;
  miningRef.current = mining;

  const refreshDashboard = useCallback(async () => {
    try {
      const [s, b, w, lb] = await Promise.all([
        anonymousMother.getStats(),
        anonymousMother.getRecentBlocks(),
        anonymousMother.getWork(),
        anonymousMother.getLeaderboard(),
      ]);
      setStats(s as unknown as Stats);
      setBlocks((b as unknown as Block[]).slice().reverse());
      setWork(w as unknown as Work);
      setLeaderboard(lb as unknown as LeaderboardEntry[]);
    } catch (err) {
      console.error("Failed to refresh PIKO dashboard", err);
    }
  }, []);

  useEffect(() => {
    // Polling the mother canister is "subscribing to an external system", the
    // documented valid use of setState-in-effect -- not derived local state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshDashboard();
    const id = setInterval(refreshDashboard, POLL_MS);
    return () => clearInterval(id);
  }, [refreshDashboard]);

  useEffect(() => {
    getStoredIdentity().then((id) => setIdentity(id));
  }, []);

  const refreshBalance = useCallback(async (id: Identity) => {
    try {
      const ledger = getLedgerActor(id);
      const owner = id.getPrincipal();
      const raw = await ledger.icrc1_balance_of({ owner });
      setBalance(raw as unknown as bigint);
    } catch (err) {
      console.error("Failed to fetch PIKO balance", err);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger canister, not derived state
      refreshBalance(identity);
    } else {
      setBalance(null);
    }
  }, [identity, refreshBalance]);

  const refreshAllowance = useCallback(async (id: Identity) => {
    try {
      const icpLedger = getIcpLedgerActor(id);
      const result = await icpLedger.icrc2_allowance({
        account: { owner: id.getPrincipal() },
        spender: { owner: motherPrincipal },
      });
      setAllowance((result as { allowance: bigint }).allowance);
    } catch (err) {
      console.error("Failed to fetch ICP allowance", err);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ICP ledger, not derived state
      refreshAllowance(identity);
    } else {
      setAllowance(null);
    }
  }, [identity, refreshAllowance]);

  async function handleLogin() {
    const id = await login();
    setIdentity(id);
  }

  async function handleLogout() {
    handleStopMining();
    await logout();
    setIdentity(null);
  }

  async function handleApprove() {
    if (!identity || !work) return;
    setApproving(true);
    try {
      const icpLedger = getIcpLedgerActor(identity);
      const amount = work.miningFeeE8s * BigInt(APPROVE_BLOCKS);
      const result = await icpLedger.icrc2_approve({
        spender: { owner: motherPrincipal },
        amount,
      });
      if ("Ok" in (result as object)) {
        refreshAllowance(identity);
      } else {
        setMiningMessage(`Approval failed: ${JSON.stringify((result as { Err: unknown }).Err)}`);
      }
    } catch (err) {
      console.error("ICP approval failed", err);
      setMiningMessage("Approval failed.");
    } finally {
      setApproving(false);
    }
  }

  async function handleCopyLedger() {
    await navigator.clipboard.writeText(ledgerCanisterId);
    setCopiedLedger(true);
    setTimeout(() => setCopiedLedger(false), 1500);
  }

  // --- In-browser mining ---
  // The worker only ever does the CPU-bound hash search; network calls
  // (submitting a found proof, fetching fresh work) stay here so the worker
  // never needs an identity or an agent.
  function ensureWorker(): Worker {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL("./worker/miner.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "progress") {
        setHashrate(msg.hashrate);
        setSessionAttempts((n) => n + msg.attempts);
      } else if (msg.type === "found") {
        void handleFound(msg.nonce as bigint);
      }
    };
    workerRef.current = worker;
    return worker;
  }

  async function handleFound(nonce: bigint) {
    const id = identityRef.current;
    if (!id) return;
    try {
      const mother = getMotherActor(id);
      const result = (await mother.submitProof(nonce)) as SubmitResult;
      if ("Ok" in result) {
        setSessionBlocks((n) => n + 1);
        setLastWinReward(result.Ok.reward);
        setMiningMessage(`Block #${result.Ok.height} is yours -- +${formatPiko(result.Ok.reward)} PIKO!`);
        setConfettiTrigger((n) => n + 1);
        refreshDashboard();
        refreshBalance(id);
        refreshAllowance(id);
      } else {
        setMiningMessage(`So close! Rejected: ${JSON.stringify(result.Err)}`);
      }
    } catch (err) {
      console.error("submitProof failed", err);
      setMiningMessage("Submission failed, still mining...");
    }
    if (miningRef.current) {
      try {
        const freshWork = await anonymousMother.getWork();
        setWork(freshWork as unknown as Work);
      } catch (err) {
        console.error("Failed to fetch fresh work", err);
      }
    }
  }

  function handleStartMining() {
    if (!identity) return;
    setMining(true);
    setSessionAttempts(0);
    setSessionBlocks(0);
    setMiningMessage(null);
  }

  function handleStopMining() {
    setMining(false);
    workerRef.current?.postMessage({ type: "stop" });
    setHashrate(0);
  }

  function handleShare() {
    const text =
      lastWinReward !== null
        ? `I just mined ${formatPiko(lastWinReward)} PIKO -- entirely on-chain, no server, on the Internet Computer. Come mine PIKO in your browser:`
        : "Mining PIKO entirely on-chain, no server, straight from my browser -- on the Internet Computer:";
    const url = window.location.href;
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  useEffect(() => {
    if (!mining || !work) return;
    const worker = ensureWorker();
    worker.postMessage({
      type: "work",
      previousHash: new Uint8Array(work.previousHash as Uint8Array),
      height: work.height,
      difficultyBits: Number(work.difficultyBits),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureWorker is stable (ref-backed), re-running on identity would restart the search needlessly
  }, [mining, work]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  const mintedPct = stats
    ? Number((stats.totalMinted * 10000n) / (stats.maxSupply || 1n)) / 100
    : 0;

  const feeApproved = work ? (allowance ?? 0n) >= work.miningFeeE8s : false;

  return (
    <main className="page">
      <Confetti trigger={confettiTrigger} />

      <header className="header">
        <div className="brand">
          <img src="/piko-logo.svg" alt="" className={`brand-logo ${mining ? "spin" : ""}`} />
          <div className="brand-text">
            <span className="brand-name">PIKO</span>
            <span className="brand-ticker">proof-of-on-chain-work ⛏️</span>
          </div>
        </div>
        <div className="wallet-box">
          {identity ? (
            <>
              <span className="principal-pill">
                {shortPrincipal(identity.getPrincipal().toText())}
                {balance !== null ? ` · ${formatPiko(balance)} PIKO` : ""}
              </span>
              <button className="button secondary" onClick={handleLogout}>
                Log out
              </button>
            </>
          ) : (
            <button className="button" onClick={handleLogin}>
              Log in with Internet Identity
            </button>
          )}
        </div>
      </header>

      <div className="marquee">
        <span className="marquee-track">
          ★彡 WELCOME TO PIKO.EXE ミ★ 100% ON-CHAIN, ZERO SERVERS ★ NO PREMINE, EVER
          ★ 21,000,000 PIKO MAX SUPPLY ★{" "}
          {stats ? `BLOCK #${stats.height.toString()} ★ DIFFICULTY ${stats.difficultyBits.toString()} BITS ★` : ""}{" "}
          BEST VIEWED AT ANY RESOLUTION ★ MINE NOW, ASK QUESTIONS LATER ★
        </span>
      </div>

      <div className="disclaimer disclaimer-strong">
        <strong>Real ICP, really burned.</strong> Mining costs{" "}
        {work ? formatIcp(work.miningFeeE8s) : "..."} ICP per block, permanently sent
        to the ICP ledger's minting account -- there is no refund path for that
        ICP once a block is accepted. PIKO is an independent, experimental,
        no-premine token with no guaranteed value and no market yet. Only mine
        with ICP you're fully OK never seeing again. Not affiliated with
        bob.fun/BOB.
      </div>

      <section className="hero">
        <h1>Mine PIKO. Win the block.</h1>
        <p>
          Hashing runs live in your browser -- no wallet software, no install.
          First valid proof wins the block and the reward, straight to your
          own principal. Real competition, real ICP on the line, real PIKO
          minted on a real ledger.
        </p>
      </section>

      <section className="block story-block">
        <h2>📁 README.TXT</h2>
        <p>
          Somewhere between a caffeine spiral and a slow Tuesday afternoon,
          someone asked: "what if mining was real, but the miner was just...
          a browser tab?" No team allocation. No VC round. No whitepaper
          longer than this readme. PIKO has exactly one job: let anyone with
          a laptop and some spare ICP take a real shot at finding a number
          first. Find it, the chain pays you. That's the whole pitch.
        </p>
        <p>
          Is PIKO going to make you rich? Almost certainly not -- it isn't
          listed anywhere, there's no liquidity, and you don't get your ICP
          back if you lose the race. Is it also a genuinely fair, no-premine,
          100%-on-chain proof-of-work token with zero servers, zero backend,
          and zero "trust us"? Also yes. Both things are true at the same
          time. Number go... we'll see. ⛏️✨
        </p>
      </section>

      <section className="block miner-panel">
        <div className="miner-panel-head">
          <h2>Mine</h2>
          {mining && (
            <span className="live-pill">
              <span className="live-dot" /> mining live
            </span>
          )}
        </div>
        {!identity ? (
          <p className="empty-state">
            Log in with Internet Identity above to mine -- found blocks are
            minted to your own principal.
          </p>
        ) : (
          <>
            <div className="stat-grid">
              <div className="stat-tile">
                <div className="stat-label">Hashrate</div>
                <div className="stat-value">{hashrate.toLocaleString()} H/s</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Attempts this session</div>
                <div className="stat-value">{sessionAttempts.toLocaleString()}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Blocks won this session</div>
                <div className="stat-value">{sessionBlocks}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Cost per block</div>
                <div className="stat-value">
                  {work ? formatIcp(work.miningFeeE8s) : "..."} ICP
                </div>
              </div>
            </div>
            <div className="miner-controls">
              {!feeApproved ? (
                <button className="button" onClick={handleApprove} disabled={approving || !work}>
                  {approving
                    ? "Approving..."
                    : `Approve ${work ? formatIcp(work.miningFeeE8s * BigInt(APPROVE_BLOCKS)) : "..."} ICP to mine`}
                </button>
              ) : mining ? (
                <button className="button secondary" onClick={handleStopMining}>
                  Stop mining
                </button>
              ) : (
                <button className="button button-cta" onClick={handleStartMining} disabled={!work}>
                  Start mining
                </button>
              )}
              {miningMessage && (
                <div className="mining-message-row">
                  <span className="mining-message">{miningMessage}</span>
                  {lastWinReward !== null && (
                    <button className="button secondary small" onClick={handleShare}>
                      Share the win
                    </button>
                  )}
                </div>
              )}
            </div>
            {!feeApproved && (
              <p className="wallet-hint">
                Mining burns {work ? formatIcp(work.miningFeeE8s) : "..."} ICP per
                block, forever, win or lose the race. Approve once to cover ~
                {APPROVE_BLOCKS} attempts.
              </p>
            )}
          </>
        )}
      </section>

      {identity && <Wallet identity={identity} />}

      <section className="block">
        <h2>Add PIKO to your wallet</h2>
        <p className="section-intro">
          PIKO is a standard ICRC-1 token -- add the ledger canister ID below
          to the NNS dapp (or any other ICRC-1-aware wallet) to see and manage
          your balance there too.
        </p>
        <div className="wallet-address-row">
          <code className="wallet-address">{ledgerCanisterId}</code>
          <button type="button" className="button secondary small" onClick={handleCopyLedger}>
            {copiedLedger ? "Copied" : "Copy"}
          </button>
        </div>
      </section>

      <section className="block">
        <h2>Chain status</h2>
        {stats ? (
          <>
            <div className="stat-grid">
              <div className="stat-tile">
                <div className="stat-label">Block height</div>
                <div className="stat-value">{stats.height.toLocaleString()}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Current reward</div>
                <div className="stat-value">{formatPiko(stats.currentReward)}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Difficulty</div>
                <div className="stat-value">{stats.difficultyBits.toString()} bits</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Next halving</div>
                <div className="stat-value">
                  {stats.nextHalvingHeight.toLocaleString()}
                </div>
              </div>
            </div>
            <div className="meter">
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.min(100, mintedPct)}%` }}
                />
              </div>
              <div className="meter-caption">
                <span>{formatPiko(stats.totalMinted)} PIKO minted</span>
                <span>{formatPiko(stats.maxSupply)} PIKO max supply</span>
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">Loading chain status...</div>
        )}
      </section>

      <section className="block">
        <h2>🏆 Top miners</h2>
        {leaderboard.length > 0 ? (
          <table className="blocks">
            <thead>
              <tr>
                <th>#</th>
                <th>Miner</th>
                <th>Blocks</th>
                <th>Total PIKO</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((entry, i) => (
                <tr key={entry.miner.toText()}>
                  <td>{i + 1}</td>
                  <td className="mono">{shortPrincipal(entry.miner.toText())}</td>
                  <td>{entry.blocksFound.toString()}</td>
                  <td>{formatPiko(entry.totalReward)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            No one's on the board yet -- mine a block and claim the top spot.
          </div>
        )}
      </section>

      <section className="block">
        <h2>Recent blocks</h2>
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
          <div className="empty-state">
            No blocks mined yet -- be the first, see "Mine" above.
          </div>
        )}
      </section>

      <section className="block tech-block">
        <h2>🔧 THE_TECH.SYS</h2>
        <p className="section-intro">
          Unlike most things claiming "utility," PIKO's mining is real code
          you can go read (see the repo link in the footer). No cron job on
          someone's server quietly pretending to be decentralized:
        </p>
        <ul className="tech-list">
          <li>
            Every hash attempt happens <strong>in your browser</strong>, via
            the Web Crypto API (<code>crypto.subtle.digest</code>) -- an
            actual SHA-256, computed on your device, right now.
          </li>
          <li>
            The <code>mother</code> canister -- a smart contract, not a
            server -- independently re-computes and verifies every submitted
            proof itself. It never trusts what your browser tells it.
          </li>
          <li>
            PIKO's ledger is the official, DFINITY-maintained ICRC-1 ledger
            canister -- the same code other real ICP tokens run, not a
            custom contract you have to take on faith.
          </li>
          <li>
            The 0.5 ICP mining fee is a genuine on-chain transfer straight to
            the ICP ledger's minting account. That's a real burn, verifiable
            by anyone, forever, on-chain.
          </li>
          <li>
            There is no backend and no database. If every AWS/GCP server on
            Earth vanished tomorrow, this site and this token would keep
            running exactly the same, because none of it is hosted --
            it's canisters, on the Internet Computer.
          </li>
        </ul>
      </section>

      <section className="block miner-guide">
        <h2>Advanced: run a dedicated miner canister</h2>
        <p>
          In-browser mining stops when you close the tab. For continuous
          mining, deploy your own <code>miner</code> canister and keep it
          topped up with cycles -- it mines around the clock on a timer, same
          hashing, same rewards (it also needs an ICP approval for the mining
          fee, done the same way from its owning identity):
        </p>
        <ol>
          <li>Clone the PIKO repository and open the project directory.</li>
          <li>
            Create your own miner canister:
            <pre>{`icp canister create miner -e ic\nicp deploy miner -e ic`}</pre>
          </li>
          <li>
            Top it up with cycles (mining and each submitted proof cost
            cycles):
            <pre>{`icp canister top-up miner --amount 5000000000000 -e ic`}</pre>
          </li>
          <li>
            Start mining:
            <pre>{`icp canister call miner start -e ic`}</pre>
          </li>
          <li>
            Check on it any time:
            <pre>{`icp canister call miner getStatus -e ic`}</pre>
          </li>
        </ol>
      </section>

      <footer className="footer">
        <p>
          PIKO is open-source, no-premine, and entirely hosted on the Internet
          Computer -- the ledger, the mining coordinator, the reference miner,
          and this site are all canisters. See the project README for the full
          architecture and the mainnet canister IDs.
        </p>
      </footer>
    </main>
  );
}

export default App;
