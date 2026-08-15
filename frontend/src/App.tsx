import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getMotherActor, getLedgerActor, getIcpLedgerActor } from "./lib/actors";
import { login, logout, getStoredIdentity } from "./lib/auth";
import { motherCanisterId, ledgerCanisterId, casinoFrontendUrl } from "./lib/canister-env";
import { formatPiko, formatIcp, shortPrincipal, timeAgo, toHex } from "./lib/format";
import { Wallet } from "./components/Wallet";
import { DeployMiner } from "./components/DeployMiner";
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
  totalIcpBurnedE8s: bigint;
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

// submitProof's #IcpFeeFailed wraps the ledger's TransferFromError -- most
// variants (TemporarilyUnavailable, BadFee, ...) are transient and worth
// retrying, but InsufficientFunds/InsufficientAllowance won't resolve on
// their own: the miner would just keep hashing valid proofs that get
// rejected forever until the wallet is topped up or re-approved. Detected
// here so the caller can stop mining instead of spinning.
function insufficientIcpReason(err: Record<string, unknown>): string | null {
  const feeError = err.IcpFeeFailed as Record<string, unknown> | undefined;
  if (!feeError) return null;
  if ("InsufficientFunds" in feeError) return "insufficient ICP balance";
  if ("InsufficientAllowance" in feeError) return "insufficient ICP allowance";
  return null;
}

const anonymousMother = getMotherActor();
const motherPrincipal = Principal.fromText(motherCanisterId);

function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [work, setWork] = useState<Work | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [icpBalance, setIcpBalance] = useState<bigint | null>(null);

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

  const refreshIcpBalance = useCallback(async (id: Identity) => {
    try {
      const icpLedger = getIcpLedgerActor(id);
      const raw = await icpLedger.icrc1_balance_of({ owner: id.getPrincipal() });
      setIcpBalance(raw as unknown as bigint);
    } catch (err) {
      console.error("Failed to fetch ICP balance", err);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ICP ledger, not derived state
      refreshIcpBalance(identity);
    } else {
      setIcpBalance(null);
    }
  }, [identity, refreshIcpBalance]);

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
        setMiningMessage(`Block #${result.Ok.height} won — +${formatPiko(result.Ok.reward)} PIKO 🎉`);
        setConfettiTrigger((n) => n + 1);
        refreshDashboard();
        refreshBalance(id);
        refreshIcpBalance(id);
        refreshAllowance(id);
      } else {
        const reason = insufficientIcpReason(result.Err);
        if (reason) {
          handleStopMining();
          refreshIcpBalance(id);
          setMiningMessage(`Mining stopped: ${reason}. Approve more ICP to keep mining.`);
          return;
        }
        setMiningMessage(`Not accepted: ${JSON.stringify(result.Err)}`);
      }
    } catch (err) {
      console.error("submitProof failed", err);
      setMiningMessage("Submission failed, still mining...");
    }
    if (miningRef.current) {
      try {
        const freshWork = await anonymousMother.getWork();
        // The worker already exited its search loop the moment it found a
        // nonce (see miner.worker.ts) -- it's idle now, waiting for a fresh
        // "work" message to resume. Reported live: right after a real win,
        // this getWork() call can still momentarily return the
        // just-solved height (ordinary IC query-routing lag, not a bug in
        // this call itself) -- if that height matches what was last posted
        // to the worker, the dedup check in the effect below would
        // conclude "nothing changed" and never repost, leaving the worker
        // permanently idle until the tab is manually stopped and
        // restarted. Clearing the ref here forces the next post through
        // regardless -- worst case it very briefly re-searches an
        // already-solved height until the following poll corrects it,
        // which is harmless, versus the freeze this prevents.
        lastPostedWorkKeyRef.current = null;
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
    // Forces the next start to always send fresh work to the worker, even
    // if the polled header happens to be identical to whatever was last
    // sent (see the comment on lastPostedWorkKeyRef below) -- otherwise a
    // stop/start with no intervening poll would leave the worker idle.
    lastPostedWorkKeyRef.current = null;
  }

  function handleShare() {
    const text =
      lastWinReward !== null
        ? `Just mined ${formatPiko(lastWinReward)} PIKO — entirely on-chain, no server, on the Internet Computer:`
        : "Mining PIKO entirely on-chain, no server, straight from my browser:";
    const url = window.location.href;
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  }

  // refreshDashboard() polls getWork() every POLL_MS and always calls
  // setWork() with a freshly-parsed object, even when the chain header
  // hasn't actually moved -- a new object reference every 5s, not a new
  // header every 5s. This effect used to re-post "work" to the searching
  // worker on every single one of those polls regardless, and the worker
  // restarts its search from nonce=0 on every "work" message it receives
  // (see miner.worker.ts). Net effect: the search never got to explore past
  // whatever a few seconds' worth of hashing covers (a few hundred thousand
  // nonces) before being reset back to nonce=0 against the *same* header --
  // if the real winning nonce for that header was beyond that range, this
  // tab could hash forever and never find it, which is exactly what a real
  // "10 minutes, nothing found" report turned out to be. Comparing the
  // actual header content (not the object reference) before re-posting is
  // what lets the search keep going past one poll interval.
  const lastPostedWorkKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mining || !work) return;
    const key = `${work.height}-${work.difficultyBits}-${toHex(work.previousHash)}`;
    if (key === lastPostedWorkKeyRef.current) return;
    lastPostedWorkKeyRef.current = key;
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
  // icpBalance is only known once fetched (post-login) -- treat "not loaded
  // yet" as "not insufficient" so the button isn't wrongly blocked while
  // still loading.
  const insufficientIcpBalance = work && icpBalance !== null ? icpBalance < work.miningFeeE8s : false;

  return (
    <main className="page">
      <Confetti trigger={confettiTrigger} />

      <header className="header">
        <div className="brand">
          <img src="/piko-logo.svg" alt="" className={`brand-logo ${mining ? "spin" : ""}`} />
          <div className="brand-text">
            <span className="brand-name">PIKO</span>
            <span className="brand-ticker">
              {stats ? (
                <>
                  <span className="pulse-dot" /> Block #{stats.height.toLocaleString()} live
                </>
              ) : (
                "Proof-of-work · Internet Computer"
              )}
            </span>
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

      {work && (
        <div className="hash-ticker">
          <span className="hash-ticker-track">
            <span className="hash-ticker-label">block</span>{" "}
            <span className="hash-ticker-value">#{work.height.toLocaleString()}</span>
            <span className="hash-ticker-sep">/</span>
            <span className="hash-ticker-label">prev_hash</span>{" "}
            <span className="hash-ticker-value">{toHex(work.previousHash).slice(0, 32)}…</span>
            <span className="hash-ticker-sep">/</span>
            <span className="hash-ticker-label">target</span>{" "}
            <span className="hash-ticker-value">{work.difficultyBits.toString()} bits</span>
            <span className="hash-ticker-sep">/</span>
            <span className="hash-ticker-label">max supply</span>{" "}
            <span className="hash-ticker-value">21,000,000 PIKO</span>
            <span className="hash-ticker-sep">/</span>
            <span className="hash-ticker-label">premine</span>{" "}
            <span className="hash-ticker-value">none, ever</span>
            <span className="hash-ticker-sep">/</span>
            <span className="hash-ticker-label">servers</span>{" "}
            <span className="hash-ticker-value">zero</span>
          </span>
        </div>
      )}

      <div className="disclaimer disclaimer-strong">
        <strong>Mining costs real ICP.</strong> {work ? formatIcp(work.miningFeeE8s) : "..."} ICP
        per block, non-refundable the moment a proof is accepted. PIKO is
        experimental, no-premine, and has no established market yet. Only
        mine with ICP you can afford to lose. Not affiliated with bob.fun or
        BOB.
      </div>

      <section className="hero">
        {stats && (
          <span className="hero-ghost">#{stats.height.toString().padStart(6, "0")}</span>
        )}
        <div className="tag-row">
          <span className="tag">No premine</span>
          <span className="tag">No VC</span>
          <span className="tag spark">100% on-chain</span>
        </div>
        <h1>Mine PIKO. ⛏️ Win the block.</h1>
        <p>
          Hashing runs in your browser. The first valid proof wins the block
          — the reward is minted straight to your principal, verified
          on-chain, with no server in between.
        </p>
      </section>

      <section className="block story-block">
        <h2>
          <span className="section-icon">#</span>About
        </h2>
        <p>
          PIKO is a fixed-supply, no-premine token minted entirely through
          proof-of-work. Every PIKO in circulation was mined by racing the
          same difficulty target everyone else races — on infrastructure with
          no off-chain component at all.
        </p>
        <p className="pull-quote">
          No team allocation, no VC round, no presale — just a browser tab
          and the same odds as everyone else.
        </p>
      </section>

      <section className={`block miner-panel ${mining ? "is-mining" : ""}`}>
        <div className="miner-panel-head">
          <h2 className="spark">
            <span className="section-icon">&gt;</span>Mine
          </h2>
          {mining && (
            <span className="live-pill">
              <span className="live-dot" /> mining live
            </span>
          )}
        </div>
        {!identity ? (
          <p className="empty-state">
            Log in to mine — blocks mint straight to your own principal.
          </p>
        ) : (
          <>
            <div className="stat-grid">
              <div className="stat-tile">
                <div className="stat-label">Hashrate</div>
                <div className={`stat-value ${mining ? "hot" : ""}`}>
                  {hashrate.toLocaleString()} H/s
                </div>
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
                <div className="stat-value token-label">
                  <img src="/icp-logo.svg" alt="" className="token-icon" />
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
                <button
                  className="button button-cta"
                  onClick={handleStartMining}
                  disabled={!work || insufficientIcpBalance}
                >
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
            {insufficientIcpBalance && (
              <p className="wallet-hint warning">
                Not enough ICP to mine — you have {formatIcp(icpBalance ?? 0n)} ICP, but each
                submission costs {work ? formatIcp(work.miningFeeE8s) : "..."} ICP. Top up your
                wallet to start mining.
              </p>
            )}
            {!feeApproved && (
              <p className="wallet-hint">
                Hashing itself is free (it's your own CPU) — the{" "}
                {work ? formatIcp(work.miningFeeE8s) : "..."} ICP fee is only charged each
                time you <em>submit</em> a valid proof, win or lose. This approval covers
                about {APPROVE_BLOCKS} submissions before you'll need to approve again.
              </p>
            )}
          </>
        )}
      </section>

      {identity && <Wallet identity={identity} />}

      <section className="block dice-teaser">
        <h2 className="spark">
          <span className="section-icon">&#127922;</span>Something to do with your PIKO
        </h2>
        <p>
          <strong>PIKO Dice</strong> is a companion game -- provably fair, 1% house edge, fully
          on-chain, resolved by the Internet Computer's own randomness. Bet PIKO or ICP, roll under
          your target, win instantly.
        </p>
        <a className="button button-cta" href={casinoFrontendUrl} target="_blank" rel="noopener noreferrer">
          Play PIKO Dice &rarr;
        </a>
      </section>

      <section className="block">
        <h2>
          <span className="section-icon">$</span>Add PIKO to your wallet
        </h2>
        <p className="section-intro">
          PIKO is a standard ICRC-1 token — add this ledger ID to the NNS
          dapp, or any other ICRC-1-aware wallet.
        </p>
        <div className="wallet-address-row">
          <code className="wallet-address">{ledgerCanisterId}</code>
          <button type="button" className="button secondary small" onClick={handleCopyLedger}>
            {copiedLedger ? "Copied" : "Copy"}
          </button>
        </div>
      </section>

      <section className="block chain-status">
        <h2 className="spark">
          <span className="section-icon">◆</span>Chain status
        </h2>
        {stats ? (
          <>
            <div className="stat-grid">
              <div className="stat-tile">
                <div className="stat-label">Block height</div>
                <div className="stat-value">{stats.height.toLocaleString()}</div>
              </div>
              <div className="stat-tile">
                <div className="stat-label">Current reward</div>
                <div className="stat-value token-label">
                  <img src="/piko-logo.svg" alt="" className="token-icon" />
                  {formatPiko(stats.currentReward)}
                </div>
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
              <div className="stat-tile stat-tile-wide">
                <div className="stat-label">ICP burned</div>
                <div className="stat-value stat-value-small">{formatIcp(stats.totalIcpBurnedE8s)} ICP</div>
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
        <h2>
          <span className="section-icon">★</span>Top miners
        </h2>
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
                  <td className={i < 3 ? `rank-${i + 1}` : ""}>{i + 1}</td>
                  <td className="mono">{shortPrincipal(entry.miner.toText())}</td>
                  <td>{entry.blocksFound.toString()}</td>
                  <td>{formatPiko(entry.totalReward)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            No one's on the board yet — mine a block and claim the top spot.
          </div>
        )}
      </section>

      <section className="block">
        <div className="miner-panel-head">
          <h2 className="spark">
            <span className="section-icon">▤</span>Recent blocks
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
          <div className="empty-state">
            No blocks mined yet — be the first, see "Mine" above.
          </div>
        )}
      </section>

      <section className="block tech-block">
        <h2>
          <span className="section-icon">?</span>How it works
        </h2>
        <p className="section-intro">
          Every step below is enforced on-chain — nothing here is simulated
          off-chain.
        </p>
        <ul className="tech-list">
          <li>
            Hashing runs <strong>in your browser</strong> via the Web Crypto
            API (<code>crypto.subtle.digest</code>) — real SHA-256, computed
            on your device.
          </li>
          <li>
            The <code>mother</code> canister independently re-verifies every
            submitted proof; it never trusts a client-supplied hash.
          </li>
          <li>
            PIKO's ledger is the official, DFINITY-maintained ICRC-1 ledger
            canister — the same code other ICP tokens run.
          </li>
          <li>
            Most of the mining fee is burned on-chain to the ICP ledger's
            minting account; a small share funds the protocol's own compute.
            Both happen automatically, in batches, verifiable on-chain.
          </li>
          <li>No backend, no database — everything here is a canister.</li>
        </ul>
      </section>

      <section className="block miner-guide">
        <h2 className="spark">
          <span className="section-icon">&raquo;</span>Advanced: run a
          dedicated miner canister
        </h2>
        <p>
          In-browser mining stops when you close the tab. A dedicated{" "}
          <code>miner</code> canister doesn't — same hashing, same rewards,
          running on its own timer, on-chain, until the ICP you send it runs
          out.
        </p>
        <p className="pull-quote">
          Not cheaper, though — worth knowing before you fund one. A browser
          hashes for free; a canister pays real cycles for every attempt,
          successful or not, because it's genuine on-chain compute running
          unattended. That's actually closer to how real proof-of-work
          works — cost scales with hashrate, like electricity for a real
          miner — but it does mean a somewhat higher total cost per block
          found. What you're paying the extra for is uptime, not odds: it
          keeps grinding while you sleep, or your laptop's closed, with no
          one keeping a tab open.
        </p>
        {identity ? (
          <DeployMiner identity={identity} miningFeeE8s={work?.miningFeeE8s ?? 0n} />
        ) : (
          <p className="empty-state">Log in above to deploy one from here.</p>
        )}
        <p className="section-intro">Or do it by hand from the CLI:</p>
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

      <div className="badge-row">
        <span className="badge">NO PREMINE</span>
        <span className="badge spark">SHA-256 VERIFIED</span>
        <span className="badge">100% ON-CHAIN</span>
        <span className="badge spark">ZERO SERVERS</span>
        <span className="badge">21M MAX SUPPLY</span>
      </div>

      <footer className="footer">
        <p>
          PIKO is open-source and entirely hosted on the Internet Computer —
          no servers, no database. See the README for the full architecture
          and mainnet canister IDs.
        </p>
        <p className="footer-links">
          <a href="/dashboard.html">Live chain dashboard</a> &nbsp;&middot;&nbsp;{" "}
          <a href={casinoFrontendUrl} target="_blank" rel="noopener noreferrer">
            Play PIKO Dice
          </a>
        </p>
      </footer>
    </main>
  );
}

export default App;
