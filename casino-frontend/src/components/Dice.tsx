import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getCasinoActor, getIcpLedgerActor, getLedgerActor } from "../lib/actors";
import { casinoCanisterId } from "../lib/canister-env";
import { formatIcp, formatPiko, parseAmount } from "../lib/format";
import { TokenKind, type Config, type BetResult, type BetError } from "../bindings/casino/casino";
import { Confetti } from "./Confetti";

interface DiceProps {
  identity: Identity | null;
}

// How many bets' worth of allowance to approve at once -- same idea as
// APPROVE_BLOCKS in the mining site's mining flow: big enough that a
// session of play doesn't mean an approval popup before every single roll,
// small enough that logging in doesn't mean signing away an unbounded
// allowance.
const APPROVE_ROLLS = 20;
// How fast the "spinning" number ticks while a bet is in flight, and how
// long the marker takes to glide to its true landing spot once the real
// result comes back -- see the CSS transition on .dice-marker, which is
// intentionally longer than this interval so a run of ticks reads as one
// continuous slide rather than a series of jumps.
const TICK_MS = 70;

const casinoPrincipal = Principal.fromText(casinoCanisterId);

function ledgerActorFor(token: TokenKind, identity?: Identity) {
  return token === TokenKind.PIKO ? getLedgerActor(identity) : getIcpLedgerActor(identity);
}

function formatToken(token: TokenKind, amount: bigint): string {
  return token === TokenKind.PIKO ? formatPiko(amount) : formatIcp(amount);
}

function betErrorMessage(err: BetError, token: TokenKind): string {
  switch (err.__kind__) {
    case "Anonymous":
      return "Log in to play.";
    case "InvalidAmount":
      return "Enter a valid bet amount.";
    case "InvalidTarget":
      return "Pick a target in range.";
    case "BetInProgress":
      return "A previous bet is still resolving -- try again in a moment.";
    case "RandomnessFailed":
      return "Couldn't draw a fair result -- your stake was refunded, claim it below.";
    case "BetTooLarge":
      return `Bet too large for the current bankroll -- max payout right now is ${formatToken(token, err.BetTooLarge.maxPayout)} ${token}. Try a smaller amount or a higher target.`;
    case "TransferFailed": {
      const inner = err.TransferFailed;
      if (inner.__kind__ === "InsufficientAllowance") return "Approve more first.";
      if (inner.__kind__ === "InsufficientFunds") return "Not enough balance to cover that bet.";
      return "Transfer failed -- try again.";
    }
    default:
      return "Bet failed.";
  }
}

export function Dice({ identity }: DiceProps) {
  const [config, setConfig] = useState<Config | null>(null);
  const [token, setToken] = useState<TokenKind>(TokenKind.PIKO);
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
    getCasinoActor()
      .getConfig()
      .then(setConfig)
      .catch((err) => console.error("Failed to load dice config", err));
  }, []);

  const refreshAllowance = useCallback(
    async (id: Identity, forToken: TokenKind) => {
      try {
        const ledger = ledgerActorFor(forToken, id);
        const result = await ledger.icrc2_allowance({
          account: { owner: id.getPrincipal() },
          spender: { owner: casinoPrincipal },
        });
        setAllowance((result as { allowance: bigint }).allowance);
      } catch (err) {
        console.error("Failed to fetch dice allowance", err);
      }
    },
    [],
  );

  useEffect(() => {
    if (identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing with the ledger, not derived state
      refreshAllowance(identity, token);
    } else {
      setAllowance(null);
    }
  }, [identity, token, refreshAllowance]);

  useEffect(() => {
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current);
    };
  }, []);

  if (!config) {
    return (
      <section className="block dice-panel">
        <h2 className="spark">
          <span className="section-icon">&#127922;</span>Dice
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
  const feeApproved = amount !== null ? (allowance ?? 0n) >= amount : false;

  async function handleApprove() {
    if (!identity || amount === null) return;
    setApproving(true);
    try {
      const ledger = ledgerActorFor(token, identity);
      const approveAmount = amount * BigInt(APPROVE_ROLLS);
      const result = await ledger.icrc2_approve({
        spender: { owner: casinoPrincipal },
        amount: approveAmount,
      });
      if ("Ok" in (result as object)) {
        refreshAllowance(identity, token);
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
      const casinoAsUser = getCasinoActor(identity);
      const result = (await casinoAsUser.placeBet(token, amount, BigInt(target))) as BetResult;
      stopTicking();
      if (result.__kind__ === "Ok") {
        const { roll, won, payoutAmount } = result.Ok;
        setDisplayRoll(Number(roll));
        setLastWon(won);
        setMessage(
          won
            ? `${Number(roll)} -- under ${target}, you won +${formatToken(token, payoutAmount)} ${token}!`
            : `${Number(roll)} -- not under ${target}, stake lost.`,
        );
        if (won) setConfettiTrigger((n) => n + 1);
        refreshAllowance(identity, token);
      } else {
        setDisplayRoll(null);
        setMessage(betErrorMessage(result.Err, token));
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
          <span className={`section-icon dice-icon ${rolling ? "spin" : ""}`}>&#127922;</span>Dice
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
          <div className="token-toggle" role="tablist" aria-label="Token">
            <button
              type="button"
              role="tab"
              aria-selected={token === TokenKind.PIKO}
              className={`token-toggle-btn ${token === TokenKind.PIKO ? "active" : ""}`}
              onClick={() => setToken(TokenKind.PIKO)}
              disabled={rolling}
            >
              <img src="/piko-logo.svg" alt="" className="token-icon" />
              PIKO
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={token === TokenKind.ICP}
              className={`token-toggle-btn ${token === TokenKind.ICP ? "active" : ""}`}
              onClick={() => setToken(TokenKind.ICP)}
              disabled={rolling}
            >
              <img src="/icp-logo.svg" alt="" className="token-icon" />
              ICP
            </button>
          </div>

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
                placeholder={`Bet amount (${token})`}
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                inputMode="decimal"
                disabled={rolling}
              />
              {!feeApproved ? (
                <button className="button" onClick={handleApprove} disabled={approving || amount === null || rolling}>
                  {approving ? "Approving..." : `Approve ${token}`}
                </button>
              ) : (
                <button className="button button-cta" onClick={handleRoll} disabled={rolling || amount === null || amount <= 0n}>
                  {rolling ? "Rolling..." : "Roll"}
                </button>
              )}
            </div>

            {potentialPayout !== null && (
              <p className="wallet-hint">
                If you win: +{formatToken(token, potentialPayout)} {token}. If you lose: -{formatToken(token, amount ?? 0n)}{" "}
                {token}, non-refundable, same as mining's fee -- see the disclaimer at the top of the site.
              </p>
            )}
            {message && <p className={`mining-message ${lastWon === true ? "good" : lastWon === false ? "critical" : ""}`}>{message}</p>}
          </div>
        </>
      )}
    </section>
  );
}
