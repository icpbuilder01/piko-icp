import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getLedgerActor, getBlackjackActor } from "./lib/actors";
import { login, logout, getStoredIdentity } from "./lib/auth";
import { blackjackCanisterId } from "./lib/canister-env";
import { formatCompact, formatPiko, parseAmount, shortPrincipal, timeAgo } from "./lib/format";
import { Wallet } from "./components/Wallet";
import { ChipAmount } from "./components/ChipAmount";
import { PikoIcon } from "./components/PikoIcon";
import { BlackjackTable } from "./components/BlackjackTable";
import { Confetti } from "./components/Confetti";
import {
  TokenKind,
  ResolvedStatus,
  type Config,
  type BlackjackError,
  type BlackjackView,
  type Rules,
  type LeaderboardEntry,
  type RecentRound,
} from "./bindings/blackjack/blackjack";
import {
  isMuted,
  setMuted,
  playClick,
  playNetWin,
  playBigWin,
  playLose,
  playCardDeal,
  playBust,
  playChipTick,
  playChipBet,
  playCoinWin,
  playDealSequence,
} from "./lib/sound";
import "./App.css";

const STATS_POLL_MS = 8000;
// How many rounds' worth of allowance to approve at once -- same idea as
// dice-frontend's APPROVE_ROLLS: big enough that a rapid session of play
// doesn't mean a wallet popup before every single bet, small enough that
// logging in doesn't sign away an unbounded allowance.
const APPROVE_ROUNDS = 20;
const PIKO_LEDGER_FEE_E8S = 10_000n;
const HISTORY_LIMIT = 16;
const RESULT_BANNER_MS = 2600;

const blackjackPrincipal = Principal.fromText(blackjackCanisterId);

function blackjackErrorMessage(err: BlackjackError): string {
  switch (err.__kind__) {
    case "Anonymous":
      return "Log in to play.";
    case "TooSoon":
      return "Slow down a little -- try again in a moment.";
    case "InvalidAmount":
      return "Enter a valid bet amount.";
    case "RandomnessFailed":
      return "Couldn't draw a fair shuffle -- your stake was refunded, claim it below.";
    case "RoundAlreadyOpen":
      return "You already have a hand in progress.";
    case "NoOpenRound":
      return "No hand in progress.";
    case "BetTooLarge": {
      const maxPayout = formatPiko(err.BetTooLarge.maxPayout);
      return `The bankroll can't cover that bet's worst case right now -- max payout available is ${maxPayout} PIKO. Try a smaller amount.`;
    }
    case "TransferFailed": {
      const inner = err.TransferFailed;
      if (inner.__kind__ === "InsufficientAllowance") return "Approve more first.";
      if (inner.__kind__ === "InsufficientFunds") return "Not enough PIKO balance to cover that bet.";
      return "Transfer failed -- try again.";
    }
    default:
      return "That didn't work.";
  }
}

// Per-hand up/down/neutral, for history chips -- the net banner across a
// whole (possibly 2-hand, after split) round is computed separately in
// handleRoundResolved from totalPayoutAmount vs. total wagered, since a
// split round's two hands can disagree (one lost, one won).
function statusKind(status: ResolvedStatus): "up" | "down" | "neutral" {
  switch (status) {
    case ResolvedStatus.PlayerBlackjack:
    case ResolvedStatus.PlayerWin:
    case ResolvedStatus.DealerBust:
      return "up";
    case ResolvedStatus.Push:
      return "neutral";
    case ResolvedStatus.PlayerBust:
    case ResolvedStatus.DealerWin:
      return "down";
  }
}

const STATUS_CHIP: Record<ResolvedStatus, string> = {
  [ResolvedStatus.PlayerBlackjack]: "BJ",
  [ResolvedStatus.PlayerWin]: "Win",
  [ResolvedStatus.DealerBust]: "Win",
  [ResolvedStatus.Push]: "Push",
  [ResolvedStatus.PlayerBust]: "Bust",
  [ResolvedStatus.DealerWin]: "Loss",
};

interface HistoryEntry {
  id: number;
  status: ResolvedStatus;
  kind: "up" | "down" | "neutral";
}

function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [showWallet, setShowWallet] = useState(false);

  const [config, setConfig] = useState<Config | null>(null);
  const [bankroll, setBankroll] = useState<bigint | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [amountInput, setAmountInput] = useState("10");
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [approving, setApproving] = useState(false);

  const [openRound, setOpenRound] = useState<BlackjackView | null>(null);
  const [dealing, setDealing] = useState(false);
  const [acting, setActing] = useState(false);
  const [resultText, setResultText] = useState<{ text: string; kind: "up" | "down" | "neutral"; stamp: string } | null>(null);
  const [lastPayout, setLastPayout] = useState<bigint | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const [shakeTrigger, setShakeTrigger] = useState(0);
  const [muted, setMutedState] = useState(isMuted);
  const [message, setMessage] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [recentRounds, setRecentRounds] = useState<RecentRound[]>([]);
  const historyId = useRef(0);
  // Each call gets its own token so a message shows for a full 4s of its own
  // regardless of what else happens in the meantime.
  const messageToken = useRef(0);
  const showMessage = useCallback((text: string) => {
    const token = ++messageToken.current;
    setMessage(text);
    setTimeout(() => {
      if (messageToken.current === token) setMessage(null);
    }, 4000);
  }, []);

  useEffect(() => {
    getStoredIdentity().then((id) => {
      setIdentity(id);
      setIdentityLoaded(true);
    });
  }, []);

  const refreshConfigAndBankroll = useCallback(async () => {
    try {
      const [c, stats] = await Promise.all([getBlackjackActor().getConfig(), getBlackjackActor().getStats()]);
      setConfig(c);
      setBankroll(stats.pikoBankroll);
    } catch (err) {
      console.error("Failed to load blackjack config/stats", err);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling on-chain state, not derived
    refreshConfigAndBankroll();
    const id = setInterval(refreshConfigAndBankroll, STATS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshConfigAndBankroll]);

  // Separate from the config/bankroll poll above on purpose: the leaderboard
  // and recent-bets tables are below-the-fold ambient content, not needed to
  // render the game itself -- bundling them into the same gate that blocks
  // the initial "Loading..." screen (via `config`) made first load wait on
  // two extra canister calls for no visible benefit.
  const refreshActivityFeeds = useCallback(async () => {
    try {
      const [board, rounds] = await Promise.all([getBlackjackActor().getLeaderboard(), getBlackjackActor().getRecentRounds()]);
      setLeaderboard(board);
      setRecentRounds(rounds);
    } catch (err) {
      console.error("Failed to load blackjack leaderboard/recent bets", err);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling on-chain state, not derived
    refreshActivityFeeds();
    const id = setInterval(refreshActivityFeeds, STATS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshActivityFeeds]);

  useEffect(() => {
    getBlackjackActor()
      .getRules()
      .then(setRules)
      .catch((err) => console.error("Failed to load rules", err));
  }, []);

  const refreshBalance = useCallback(async (id: Identity) => {
    try {
      const raw = await getLedgerActor().icrc1_balance_of({ owner: id.getPrincipal() });
      setBalance(raw);
    } catch (err) {
      console.error("Failed to fetch PIKO balance", err);
    }
  }, []);

  const refreshAllowance = useCallback(async (id: Identity) => {
    try {
      const result = await getLedgerActor(id).icrc2_allowance({
        account: { owner: id.getPrincipal() },
        spender: { owner: blackjackPrincipal },
      });
      setAllowance((result as { allowance: bigint }).allowance);
    } catch (err) {
      console.error("Failed to fetch blackjack allowance", err);
    }
  }, []);

  useEffect(() => {
    if (!identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on logout, not derived state
      setBalance(null);
      setAllowance(null);
      return;
    }
    refreshBalance(identity);
    refreshAllowance(identity);
    const id = setInterval(() => refreshBalance(identity), STATS_POLL_MS);
    return () => clearInterval(id);
  }, [identity, refreshBalance, refreshAllowance]);

  // Resumes a hand still open server-side after a page reload -- deal()/
  // hit()/stand() all keep local state in sync themselves, this is only for
  // the "came back to a half-played hand" case.
  useEffect(() => {
    if (!identity) return;
    getBlackjackActor(identity)
      .getOpenRound()
      .then((r) => {
        if (r) setOpenRound(r);
      })
      .catch((err) => console.error("Failed to resync open round", err));
  }, [identity]);

  async function handleLogin(): Promise<Identity | null> {
    const id = await login();
    setIdentity(id);
    return id;
  }

  async function handleLogout() {
    await logout();
    setIdentity(null);
  }

  function handleToggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  const amount = parseAmount(amountInput);
  const feeApproved = amount !== null ? (allowance ?? 0n) >= amount + PIKO_LEDGER_FEE_E8S : false;
  const handOpen = openRound?.__kind__ === "Open";

  // A visible, obviously-tappable alternative to typing directly into the
  // (small, easy-to-miss-as-editable) bet field -- works off the same
  // amountInput state, just nudging it by a whole PIKO at a time.
  function adjustBet(deltaPiko: number) {
    playChipTick();
    const current = parseFloat(amountInput) || 0;
    const next = Math.max(1, current + deltaPiko);
    setAmountInput(String(next));
  }

  async function handleApprove() {
    const id = identity ?? (await handleLogin());
    if (!id || amount === null) return;
    setApproving(true);
    try {
      const approveAmount = (amount + PIKO_LEDGER_FEE_E8S) * BigInt(APPROVE_ROUNDS);
      const result = await getLedgerActor(id).icrc2_approve({
        spender: { owner: blackjackPrincipal },
        amount: approveAmount,
      });
      if (result.__kind__ === "Ok") {
        refreshAllowance(id);
      } else {
        showMessage(`Approval failed: ${JSON.stringify(result.Err)}`);
      }
    } catch (err) {
      console.error("Approval failed", err);
      showMessage("Approval failed -- try again.");
    } finally {
      setApproving(false);
    }
  }

  function handleRoundResolved(resolved: Extract<BlackjackView, { __kind__: "Resolved" }>["Resolved"]) {
    const { hands, totalPayoutAmount } = resolved;
    const totalWagered = hands.reduce((sum, h) => sum + h.betAmount, 0n);
    const kind: "up" | "down" | "neutral" = totalPayoutAmount > totalWagered ? "up" : totalPayoutAmount === totalWagered ? "neutral" : "down";
    const hasBlackjack = hands.some((h) => h.status === ResolvedStatus.PlayerBlackjack);
    const allBust = hands.every((h) => h.status === ResolvedStatus.PlayerBust);

    let text: string;
    let stamp: string;
    if (kind === "up") {
      text = hasBlackjack ? `Blackjack! +${formatPiko(totalPayoutAmount)} PIKO` : `+${formatPiko(totalPayoutAmount)} PIKO`;
      stamp = hasBlackjack ? "Blackjack!" : "You win!";
    } else if (kind === "neutral") {
      text = `Push -- ${formatPiko(totalPayoutAmount)} PIKO back`;
      stamp = "Push";
    } else {
      text = allBust ? "Bust -- try again" : "No win -- try again";
      stamp = allBust ? "Bust" : "Dealer wins";
    }
    const outcome = { text, kind, stamp };

    // One history chip per hand -- most faithful to what actually happened
    // on a split round (one hand can win while the other loses).
    setHistory((prev) =>
      [...hands.map((h) => ({ id: ++historyId.current, status: h.status, kind: statusKind(h.status) })), ...prev].slice(0, HISTORY_LIMIT),
    );
    setResultText(outcome);
    setLastPayout(totalPayoutAmount);
    setTimeout(() => setResultText(null), RESULT_BANNER_MS);
    if (hasBlackjack) {
      setConfettiTrigger((n) => n + 1);
      setShakeTrigger((n) => n + 1);
      playBigWin();
      playCoinWin();
    } else if (kind === "up") {
      playNetWin(2);
      playCoinWin();
    } else if (hands.some((h) => h.status === ResolvedStatus.PlayerBust)) {
      playBust();
    } else {
      playLose();
    }
    if (identity) {
      refreshBalance(identity);
      refreshAllowance(identity);
    }
    refreshConfigAndBankroll();
  }

  async function handleDeal() {
    if (dealing || handOpen) return;
    const id = identity ?? (await handleLogin());
    if (!id || amount === null || amount <= 0n || !config) {
      showMessage("Enter a valid bet amount.");
      return;
    }
    if (!feeApproved) {
      showMessage("Approve more first -- your approved allowance ran out.");
      return;
    }
    playChipBet();
    setDealing(true);
    setResultText(null);
    setLastPayout(null);
    // Optimistic, immediate -- deal() actually spends amount+fee of
    // allowance on-chain; waiting for the call to land before reflecting
    // that locally would let a second click race in on a stale allowance
    // read. Corrected for real by the next refreshAllowance() regardless.
    setAllowance((prev) => (prev !== null ? (prev > amount + PIKO_LEDGER_FEE_E8S ? prev - amount - PIKO_LEDGER_FEE_E8S : 0n) : prev));
    try {
      const result = await getBlackjackActor(id).deal(TokenKind.PIKO, amount);
      if (result.__kind__ === "Err") {
        showMessage(blackjackErrorMessage(result.Err));
        setDealing(false);
        refreshAllowance(id);
        return;
      }
      playDealSequence(2);
      setOpenRound(result.Ok);
      if (result.Ok.__kind__ === "Resolved") handleRoundResolved(result.Ok.Resolved);
      setDealing(false);
      // doubleDown()/split() both refresh allowance unconditionally after a
      // successful pull; deal() only did so via handleRoundResolved's own
      // refresh (i.e. only when the round resolved immediately on a
      // natural), leaving the far more common #Open outcome showing a
      // purely optimistic local subtraction until the round eventually
      // resolves or the page reloads. Refresh here too so it's consistent.
      refreshAllowance(id);
    } catch (err) {
      console.error("Deal failed", err);
      showMessage("Deal failed -- try again.");
      setDealing(false);
      refreshAllowance(id);
    }
  }

  async function handleHit() {
    if (!identity || acting || !handOpen) return;
    setActing(true);
    playClick();
    try {
      const result = await getBlackjackActor(identity).hit();
      if (result.__kind__ === "Err") {
        showMessage(blackjackErrorMessage(result.Err));
        setActing(false);
        return;
      }
      playCardDeal();
      setOpenRound(result.Ok);
      if (result.Ok.__kind__ === "Resolved") handleRoundResolved(result.Ok.Resolved);
      setActing(false);
    } catch (err) {
      console.error("Hit failed", err);
      showMessage("Hit failed -- try again.");
      setActing(false);
    }
  }

  async function handleStand() {
    if (!identity || acting || !handOpen) return;
    setActing(true);
    playClick();
    try {
      const result = await getBlackjackActor(identity).stand();
      if (result.__kind__ === "Err") {
        showMessage(blackjackErrorMessage(result.Err));
        setActing(false);
        return;
      }
      setOpenRound(result.Ok);
      if (result.Ok.__kind__ === "Resolved") handleRoundResolved(result.Ok.Resolved);
      setActing(false);
    } catch (err) {
      console.error("Stand failed", err);
      showMessage("Stand failed -- try again.");
      setActing(false);
    }
  }

  async function handleDoubleDown() {
    if (!identity || acting || !handOpen) return;
    setActing(true);
    playChipBet();
    try {
      const result = await getBlackjackActor(identity).doubleDown();
      if (result.__kind__ === "Err") {
        showMessage(blackjackErrorMessage(result.Err));
        setActing(false);
        return;
      }
      playCardDeal();
      setOpenRound(result.Ok);
      if (result.Ok.__kind__ === "Resolved") handleRoundResolved(result.Ok.Resolved);
      setActing(false);
      if (identity) refreshAllowance(identity);
    } catch (err) {
      console.error("Double down failed", err);
      showMessage("Double down failed -- try again.");
      setActing(false);
    }
  }

  async function handleSplit() {
    if (!identity || acting || !handOpen) return;
    setActing(true);
    playChipBet();
    try {
      const result = await getBlackjackActor(identity).split();
      if (result.__kind__ === "Err") {
        showMessage(blackjackErrorMessage(result.Err));
        setActing(false);
        return;
      }
      playDealSequence(2);
      setOpenRound(result.Ok);
      if (result.Ok.__kind__ === "Resolved") handleRoundResolved(result.Ok.Resolved);
      setActing(false);
      if (identity) refreshAllowance(identity);
    } catch (err) {
      console.error("Split failed", err);
      showMessage("Split failed -- try again.");
      setActing(false);
    }
  }

  async function handleClaimPayout() {
    if (!identity) return;
    showMessage("Checking for a pending payout...");
    try {
      const result = await getBlackjackActor(identity).claimPendingPayout(TokenKind.PIKO);
      if (result.__kind__ === "Ok") {
        showMessage("Payout claimed -- check your balance.");
        refreshBalance(identity);
      } else {
        showMessage("Nothing pending to claim right now.");
      }
    } catch (err) {
      console.error("Claim payout failed", err);
      showMessage("Couldn't check for a pending payout -- try again later.");
    }
  }

  return (
    <main className="page">
      <Confetti trigger={confettiTrigger} />
      {showWallet && identity && (
        <Wallet
          identity={identity}
          balance={balance}
          onClose={() => setShowWallet(false)}
          onBalanceChange={() => refreshBalance(identity)}
        />
      )}

      <header className="header">
        <div className="brand">
          <img src="/piko-logo.svg" alt="" className="brand-logo" />
          <div className="brand-text">
            <span className="brand-name">&#127183; PikoBlackjack</span>
            <span className="brand-ticker">Provably-fair, bet in PIKO</span>
          </div>
        </div>
        <div className="wallet-box">
          <button className="button secondary small mute-button" onClick={handleToggleMute} aria-label={muted ? "Unmute sound" : "Mute sound"}>
            {muted ? "\u{1F507}" : "\u{1F50A}"}
          </button>
          {identity && (
            <button className="button secondary small wallet-balance-button" onClick={() => setShowWallet(true)}>
              {balance !== null ? <ChipAmount amount={balance} unit="PIKO" decimals={2} /> : "Wallet"}
            </button>
          )}
          {identity ? (
            <button className="button secondary" onClick={handleLogout}>
              Log out
            </button>
          ) : (
            identityLoaded && (
              <button className="button" onClick={handleLogin}>
                Log in with Internet Identity
              </button>
            )
          )}
        </div>
      </header>

      {!identityLoaded || !config ? (
        <div className="empty-state">Loading...</div>
      ) : (
        <>
          {!identity && (
            <section className="hero">
              <div className="tag-row">
                <span className="tag">Provably fair</span>
                <span className="tag spark">Real Hit/Stand, disclosed rules</span>
                <span className="tag">No login needed to watch</span>
              </div>
              <h1>Beat the dealer.</h1>
              <p>
                Single-deck Blackjack, fully on-chain: the whole deck is shuffled by the Internet Computer's own
                threshold randomness the moment you deal -- not a client-side RNG, not a "trust us" seed. The rules
                below are the real ones the canister uses. Log in with Internet Identity to play.
              </p>
            </section>
          )}

          <section className="block slot-panel">
            <h2>
              Blackjack <span className="section-icon">&#127183;</span>
            </h2>

            <div className="slot-topline">
              <div className="bankroll-stat">
                <span className="bankroll-label">House bankroll</span>
                <span className="bankroll-value">{bankroll !== null ? <ChipAmount amount={bankroll} unit="PIKO" size={13} decimals={2} /> : "..."}</span>
              </div>
            </div>

            <BlackjackTable
              round={openRound}
              dealing={dealing}
              shakeTrigger={shakeTrigger}
              stamp={resultText ? { text: resultText.stamp, kind: resultText.kind } : null}
              rules={rules}
              bet={handOpen ? amount : null}
            />

            <p className={`slot-result ${resultText ? resultText.kind : ""}`}>{resultText?.text ?? " "}</p>

            {history.length > 0 && (
              <div className="slot-history">
                {history.map((h) => (
                  <span key={h.id} className={`slot-history-chip ${h.kind}`}>
                    {STATUS_CHIP[h.status]}
                  </span>
                ))}
              </div>
            )}

            <div className="bj-stat-bar">
              <div className="bj-stat">
                <span className="bj-stat-label">Balance</span>
                <span className="bj-stat-value">{balance !== null ? formatCompact(balance) : "..."}</span>
              </div>
              <div className="bj-stat-divider" aria-hidden="true" />
              <div className="bj-stat">
                <span className="bj-stat-label">Payout</span>
                <span className="bj-stat-value">{lastPayout !== null ? formatCompact(lastPayout) : "0"}</span>
              </div>
              <div className="bj-stat-divider" aria-hidden="true" />
              <div className="bj-stat">
                <span className="bj-stat-label bj-stat-label-with-chips">
                  Bet
                  <PikoIcon size={11} />
                </span>
                {handOpen ? (
                  <span className="bj-stat-value">{amount !== null ? formatCompact(amount) : "0"}</span>
                ) : (
                  <div className="bj-bet-stepper">
                    <button type="button" className="bj-bet-step" onClick={() => adjustBet(-5)} aria-label="Decrease bet">
                      &minus;
                    </button>
                    <input
                      className="bj-stat-bet-input"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      inputMode="decimal"
                    />
                    <button type="button" className="bj-bet-step" onClick={() => adjustBet(5)} aria-label="Increase bet">
                      &#43;
                    </button>
                  </div>
                )}
              </div>
            </div>

            {handOpen ? (
              <div className="bj-action-row">
                <button className="bj-action-btn bj-action-stand" disabled={acting} onClick={handleStand} title="Stand">
                  <span className="bj-action-icon">&#9995;</span>
                  <span className="bj-action-label">Stand</span>
                </button>
                <button className="bj-action-btn bj-action-hit" disabled={acting} onClick={handleHit} title="Hit">
                  <span className="bj-action-icon">&#10133;</span>
                  <span className="bj-action-label">Hit</span>
                </button>
                <button
                  className="bj-action-btn bj-action-double"
                  disabled={acting || !(openRound.__kind__ === "Open" && openRound.Open.canDouble)}
                  onClick={handleDoubleDown}
                  title="Double down"
                >
                  <span className="bj-action-icon">&times;2</span>
                  <span className="bj-action-label">Double</span>
                </button>
                <button
                  className="bj-action-btn bj-action-split"
                  disabled={acting || !(openRound.__kind__ === "Open" && openRound.Open.canSplit)}
                  onClick={handleSplit}
                  title={openRound.__kind__ === "Open" && openRound.Open.canSplit ? "Split" : "Split needs two cards of the exact same rank (e.g. two Queens) -- a King+Queen doesn't qualify"}
                >
                  <span className="bj-action-icon">&#9996;</span>
                  <span className="bj-action-label">Split</span>
                </button>
              </div>
            ) : feeApproved ? (
              <button className={`button button-cta ${dealing ? "" : "breathe"}`} disabled={dealing || amount === null} onClick={handleDeal}>
                {dealing ? "Dealing..." : "Deal"}
              </button>
            ) : (
              <button className="button button-cta" disabled={approving || amount === null} onClick={handleApprove}>
                {approving ? "Approving..." : "Approve to play"}
              </button>
            )}

            {message && <p className="error-text">{message}</p>}
          </section>

          <section className="block">
            <h2>
              Top players <span className="section-icon">&#127942;</span>
            </h2>
            <div className="table-scroll">
              <table className="blocks">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Player</th>
                    <th>PIKO wagered</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="empty-state">
                        No players yet -- be the first.
                      </td>
                    </tr>
                  ) : (
                    leaderboard.map((entry, i) => (
                      <tr key={entry.player.toText()}>
                        <td className={i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : undefined}>{i + 1}</td>
                        <td className="mono">{shortPrincipal(entry.player.toText())}</td>
                        <td>{formatCompact(entry.wageredPiko)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="block">
            <h2>
              <span>
                Recent bets <span className="section-icon">&#127183;</span>
              </span>
              <span className="live-pill">
                <span className="live-dot"></span> live feed
              </span>
            </h2>
            <div className="table-scroll">
              <table className="blocks">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Bet</th>
                    <th>Result</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRounds.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="empty-state">
                        No bets yet -- be the first.
                      </td>
                    </tr>
                  ) : (
                    [...recentRounds]
                      .reverse()
                      .slice(0, 15)
                      .map((round, i) => {
                        const totalPayout = round.hands.reduce((sum, h) => sum + h.payoutAmount, 0n);
                        const totalWagered = round.amount * BigInt(round.hands.length);
                        const net = totalPayout - totalWagered;
                        return (
                          <tr key={i}>
                            <td className="mono">{shortPrincipal(round.player.toText())}</td>
                            <td>{formatCompact(round.amount)}</td>
                            <td className={net > 0n ? "good" : net < 0n ? "bad" : undefined}>
                              {net > 0n ? `+${formatCompact(net)}` : net < 0n ? "lost" : "push"}
                            </td>
                            <td>{timeAgo(round.timestamp)}</td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <footer className="footer">
            <p>
              Every hand escrows your stake on-chain the moment you deal, and the whole deck is shuffled right then
              by a single fresh call to the Internet Computer's raw_rand -- see getRules() in the project source for
              the exact numbers, disclosed openly rather than hidden behind a house RTP figure.
            </p>
            {identity && (
              <p>
                <button className="footer-link" onClick={handleClaimPayout}>
                  Claim a stuck payout
                </button>
              </p>
            )}
          </footer>
        </>
      )}
    </main>
  );
}

export default App;
