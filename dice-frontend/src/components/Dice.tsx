import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getDiceActor, getLedgerActor } from "../lib/actors";
import { diceCanisterId } from "../lib/canister-env";
import { formatPiko, parseAmount } from "../lib/format";
import { TokenKind, type Config, type BetResult, type BetError } from "../bindings/dice/dice";
import { Confetti } from "./Confetti";

interface DiceProps {
  identity: Identity | null;
}

// This site only ever bets PIKO -- the `dice` canister itself still
// understands ICP too (see dice/src/main.mo), but there's no ICP wallet
// UI here at all (see Wallet.tsx), so TokenKind.PIKO is the only value ever
// sent to placeBet().
const TOKEN = TokenKind.PIKO;

// How many bets' worth of allowance to approve at once -- same idea as
// APPROVE_BLOCKS in the mining site's mining flow: big enough that a
// session of play doesn't mean an approval popup before every single roll,
// small enough that logging in doesn't mean signing away an unbounded
// allowance.
const APPROVE_ROLLS = 20;
// Every icrc2_transfer_from pull -- which is how dice pulls a bet's stake --
// also deducts the PIKO ledger's own transfer fee from the caller's
// allowance, on top of the stake amount itself (same gotcha the mining
// site's App.tsx already accounts for on the ICP side -- see its own
// ICP_LEDGER_FEE_E8S comment). Without budgeting this in, both the approved
// amount and the "am I covered" check here would read as enough allowance
// for one more roll than the ledger will actually permit, and a bet would
// fail on-chain with a confusing InsufficientAllowance right after the UI
// said Roll instead of Approve. This is PIKO's own ledger fee (set in
// ledger/icrc1_ledger_init.args.template), unrelated to ICP's, but happens
// to share the same value today.
const PIKO_LEDGER_FEE_E8S = 10_000n;
// How fast the "spinning" number ticks while a bet is in flight, and how
// long the marker takes to glide to its true landing spot once the real
// result comes back -- see the CSS transition on .dice-marker, which is
// intentionally longer than this interval so a run of ticks reads as one
// continuous slide rather than a series of jumps.
const TICK_MS = 70;

const dicePrincipal = Principal.fromText(diceCanisterId);

// attemptedPayout is what *this* bet's stake/target would have paid out if
// it won -- only known here, not from the error alone, and worth showing
// explicitly for BetTooLarge: the cap is on *payout*, not on the stake you
// typed, so "you bet 20, the max is 21" reads as nonsensical unless the
// message also shows what your 20 would actually have paid out at your
// chosen target (which can easily be well above 21 at a low target/high
// multiplier).
function betErrorMessage(err: BetError, attemptedPayout: bigint | null): string {
  switch (err.__kind__) {
    case "Anonymous":
      return "Log in to play.";
    case "TooSoon":
      return "Slow down a little -- try again in a moment.";
    case "InvalidAmount":
      return "Enter a valid bet amount.";
    case "InvalidTarget":
      return "Pick a target in range.";
    case "BetInProgress":
      return "A previous bet is still resolving -- try again in a moment.";
    case "RandomnessFailed":
      return "Couldn't draw a fair result -- your stake was refunded, claim it below.";
    case "BetTooLarge": {
      const maxPayout = formatPiko(err.BetTooLarge.maxPayout);
      const yours = attemptedPayout !== null ? `Your bet would have paid ${formatPiko(attemptedPayout)} PIKO if you won -- ` : "";
      return `${yours}the max payout the bankroll can cover right now is ${maxPayout} PIKO. Try a smaller amount or a higher target (lower target = bigger multiplier = bigger payout for the same stake).`;
    }
    case "TransferFailed": {
      const inner = err.TransferFailed;
      if (inner.__kind__ === "InsufficientAllowance") return "Approve more first.";
      if (inner.__kind__ === "InsufficientFunds") return "Not enough PIKO balance to cover that bet.";
      return "Transfer failed -- try again.";
    }
    default:
      return "Bet failed.";
  }
}

export function Dice({ identity }: DiceProps) {
  const [config, setConfig] = useState<Config | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [target, setTarget] = useState(50);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [approving, setApproving] = useState(false);

  const [rolling, setRolling] = useState(false);
  const [displayRoll, setDisplayRoll] = useState<number | null>(null);
  const [lastWon, setLastWon] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    getDiceActor()
      .getConfig()
      .then(setConfig)
      .catch((err) => console.error("Failed to load dice config", err));
  }, []);

  const refreshAllowance = useCallback(async (id: Identity) => {
    try {
      const result = await getLedgerActor(id).icrc2_allowance({
        account: { owner: id.getPrincipal() },
        spender: { owner: dicePrincipal },
      });
      setAllowance((result as { allowance: bigint }).allowance);
    } catch (err) {
      console.error("Failed to fetch dice allowance", err);
    }
  }, []);

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger, not derived state
      refreshAllowance(identity);
    } else {
      setAllowance(null);
    }
  }, [identity, refreshAllowance]);

  useEffect(() => {
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, []);

  if (!config) {
    return (
      <section className="block dice-panel">
        <h2 className="spark">
          Dice <span className="section-icon">&#127922;</span>
        </h2>
        <div className="empty-state">Loading table...</div>
      </section>
    );
  }

  const minTarget = Number(config.minTarget);
  const maxTarget = Number(config.maxTarget);
  const amount = parseAmount(amountInput);
  const payoutMultiplier = target > 0 ? Number(config.payoutNumerator) / target : 0;
  const potentialPayout = amount !== null ? (amount * config.payoutNumerator) / BigInt(target) : null;
  const feeApproved = amount !== null ? (allowance ?? 0n) >= amount + PIKO_LEDGER_FEE_E8S : false;

  async function handleApprove() {
    if (!identity || amount === null) return;
    setApproving(true);
    try {
      const approveAmount = (amount + PIKO_LEDGER_FEE_E8S) * BigInt(APPROVE_ROLLS);
      const result = await getLedgerActor(identity).icrc2_approve({
        spender: { owner: dicePrincipal },
        amount: approveAmount,
      });
      if ("Ok" in (result as object)) {
        refreshAllowance(identity);
      } else {
        setMessage(`Approval failed: ${JSON.stringify((result as { Err: unknown }).Err)}`);
      }
    } catch (err) {
      console.error("Dice approval failed", err);
      setMessage("Approval failed.");
    } finally {
      setApproving(false);
    }
  }

  function startTicking() {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    tickRef.current = window.setInterval(() => {
      setDisplayRoll(Math.floor(Math.random() * 100));
    }, TICK_MS);
  }

  function stopTicking() {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  async function handleRoll() {
    if (!identity || amount === null || amount <= 0n || rolling) return;
    setMessage(null);
    setLastWon(null);
    setRolling(true);
    startTicking();
    try {
      const diceAsUser = getDiceActor(identity);
      const result = (await diceAsUser.placeBet(TOKEN, amount, BigInt(target))) as BetResult;
      stopTicking();
      if (result.__kind__ === "Ok") {
        const { roll, won, payoutAmount } = result.Ok;
        setDisplayRoll(Number(roll));
        setLastWon(won);
        setMessage(
          won
            ? `${Number(roll)} -- under ${target}, you won +${formatPiko(payoutAmount)} PIKO!`
            : `${Number(roll)} -- not under ${target}, stake lost.`,
        );
        if (won) setConfettiTrigger((n) => n + 1);
        refreshAllowance(identity);
      } else {
        setDisplayRoll(null);
        setMessage(betErrorMessage(result.Err, potentialPayout));
      }
    } catch (err) {
      stopTicking();
      console.error("placeBet failed", err);
      setDisplayRoll(null);
      setMessage("Bet failed, nothing was charged if this was a network error -- check your balance.");
    } finally {
      setRolling(false);
    }
  }

  const markerPct = displayRoll !== null ? (displayRoll / 99) * 100 : null;
  const zonePct = Math.min(100, Math.max(0, target));

  return (
    <section className={`block dice-panel ${rolling ? "is-rolling" : ""}`}>
      <Confetti trigger={confettiTrigger} />
      <div className="miner-panel-head">
        <h2 className="spark">
          Dice <span className={`section-icon dice-icon ${rolling ? "spin" : ""}`}>&#127922;</span>
        </h2>
        <span className="dice-edge-pill">1% house edge, same odds as any provably-fair dice site</span>
      </div>
      <p className="section-intro">
        Pick a target, roll under it to win. Resolved by <code>raw_rand()</code> on-chain, after your
        stake is already pulled -- there's no point where the house (or you) can see the result and
        back out. Payout capped against this game's real, live bankroll -- see "Bet too large" below if
        you hit it.
      </p>

      {!identity ? (
        <p className="empty-state">Log in to play -- winnings pay out straight to your own principal.</p>
      ) : (
        <>
          <div className="dice-track-wrap">
            <div className="dice-track" style={{ background: `linear-gradient(to right, var(--good) 0%, var(--good) ${zonePct}%, var(--critical) ${zonePct}%, var(--critical) 100%)` }}>
              {markerPct !== null && (
                <div className={`dice-marker ${lastWon === true ? "won" : lastWon === false ? "lost" : ""}`} style={{ left: `${markerPct}%` }} />
              )}
            </div>
            <div className="dice-readout">
              <span className={`dice-number ${rolling ? "ticking" : ""} ${lastWon !== null ? "settled" : ""}`}>
                {displayRoll !== null ? displayRoll.toString().padStart(2, "0") : "--"}
              </span>
              <span className="dice-readout-label">last roll (0-99)</span>
            </div>
          </div>

          <div className="dice-controls">
            <label className="dice-target-row">
              <span>
                Roll under <strong>{target}</strong> ({target}% chance, {payoutMultiplier.toFixed(2)}&times; payout)
              </span>
              <input
                type="range"
                className="dice-slider"
                min={minTarget}
                max={maxTarget}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                disabled={rolling}
              />
            </label>

            <div className="wallet-send-row">
              <input
                className="input"
                placeholder="Bet amount (PIKO)"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                inputMode="decimal"
                disabled={rolling}
              />
              {!feeApproved ? (
                <button className="button" onClick={handleApprove} disabled={approving || amount === null || rolling}>
                  {approving ? "Approving..." : "Approve PIKO"}
                </button>
              ) : (
                <button className="button button-cta" onClick={handleRoll} disabled={rolling || amount === null || amount <= 0n}>
                  {rolling ? "Rolling..." : "Roll"}
                </button>
              )}
            </div>

            {potentialPayout !== null && (
              <p className="wallet-hint">
                If you win: +{formatPiko(potentialPayout)} PIKO. If you lose: -{formatPiko(amount ?? 0n)} PIKO,
                non-refundable, same as mining's fee -- see the disclaimer at the top of the site.
              </p>
            )}
            {message && <p className={`mining-message ${lastWon === true ? "good" : lastWon === false ? "critical" : ""}`}>{message}</p>}
          </div>
        </>
      )}
    </section>
  );
}
