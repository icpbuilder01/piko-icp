import { useEffect, useRef, useState, type CSSProperties } from "react";
import { formatPiko } from "../lib/format";
import { isMuted, setMuted, sfx } from "../lib/sound";

export interface Outcome {
  id: number;
  roll: number;
  won: boolean;
  target: number;
  stake: bigint;
  payout: bigint;
}

export interface HistoryEntry {
  id: number;
  roll: number;
  won: boolean;
}

interface DiceStageProps {
  // The bet is in flight and no result is back yet: the ball bounces.
  spinning: boolean;
  // A new id starts the landing animation; onSettled fires once it lands.
  outcome: Outcome | null;
  target: number;
  multiplier: number;
  history: HistoryEntry[];
  streak: number; // >0 wins in a row, <0 losses in a row
  onSettled: (o: Outcome) => void;
}

// Highest roll value, i.e. the right end of the track.
const MAX_ROLL = 99;
// Bounce speed while waiting for the canister (radians per ms).
const SPIN_SPEED = 0.0075;
// How long the ball takes to swing to a stop once the real roll is known.
const SETTLE_MS = 1400;
// The landing swing always starts at least this far from the result, so
// even a ball that happens to be near its landing spot still builds suspense.
const MIN_SWING = 32;
// Losing by this little (or less) earns a "so close" banner.
const NEAR_MISS = 4;
const BIG_WIN_MULTIPLIER = 5;
// Trail ghosts follow the ball this many frames behind each.
const TRAIL = [3, 6, 9, 12];

// The popup is read at a glance, so at most 4 decimals ("+21.5217 PIKO").
function shortPiko(raw: bigint): string {
  return formatPiko(raw).replace(/(\.\d{4})\d+$/, "$1");
}

function reflect(x: number): number {
  if (x < 0) return -x;
  if (x > MAX_ROLL) return 2 * MAX_ROLL - x;
  return x;
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

export function DiceStage({
  spinning,
  outcome,
  target,
  multiplier,
  history,
  streak,
  onSettled,
}: DiceStageProps) {
  const laneRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<HTMLDivElement>(null);
  const trailRefs = useRef<(HTMLDivElement | null)[]>([]);
  const numberRef = useRef<HTMLSpanElement>(null);
  const posRef = useRef(MAX_ROLL / 2);
  const pastRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(target);
  const onSettledRef = useRef(onSettled);
  const [landedId, setLandedId] = useState<number | null>(null);
  const landed = outcome && outcome.id === landedId ? outcome : null;
  const [muted, setMutedState] = useState(isMuted);

  useEffect(() => {
    targetRef.current = target;
    onSettledRef.current = onSettled;
  });

  // Moves the ball, its trail and the big number without a React render --
  // this runs every animation frame.
  function paint(pos: number, number: number | null, liveTarget: number) {
    posRef.current = pos;
    const past = pastRef.current;
    past.unshift(pos);
    if (past.length > TRAIL[TRAIL.length - 1] + 1) past.pop();
    const lane = laneRef.current;
    if (lane) lane.style.setProperty("--p", String(pos / MAX_ROLL));
    TRAIL.forEach((lag, i) => {
      const el = trailRefs.current[i];
      if (el)
        el.style.setProperty("--p", String((past[lag] ?? pos) / MAX_ROLL));
    });
    const winning = Math.round(pos) < liveTarget;
    ballRef.current?.classList.toggle("in-win", winning);
    ballRef.current?.classList.toggle("in-lose", !winning);
    if (numberRef.current && number !== null) {
      numberRef.current.textContent = String(number).padStart(2, "0");
      numberRef.current.classList.toggle("in-win", winning);
      numberRef.current.classList.toggle("in-lose", !winning);
    }
  }

  function stopLoop() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  // Waiting for the canister: bounce wall to wall, number reel spinning.
  useEffect(() => {
    if (!spinning) return;
    stopLoop();
    const start = performance.now();
    const phase0 = Math.asin(
      Math.max(-1, Math.min(1, posRef.current / (MAX_ROLL / 2) - 1)),
    );
    let lastReel = 0;
    let lastTick = 0;
    const frame = (now: number) => {
      const t = now - start;
      // Ease into full speed over the first 400ms instead of jumping to it
      // (phase is the integral of a linearly ramping speed).
      const phase = phase0 + SPIN_SPEED * (t < 400 ? (t * t) / 800 : t - 200);
      const pos = (MAX_ROLL / 2) * (1 + Math.sin(phase));
      let number: number | null = null;
      if (now - lastReel > 55) {
        number = Math.floor(Math.random() * (MAX_ROLL + 1));
        lastReel = now;
      }
      if (now - lastTick > 95) {
        sfx.tick();
        lastTick = now;
      }
      paint(pos, number, targetRef.current);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return stopLoop;
  }, [spinning]);

  // Result is in: damped swing around the landing spot, then impact.
  useEffect(() => {
    if (!outcome) return;
    stopLoop();
    const o = outcome;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const land = () => {
      paint(o.roll, o.roll, o.target);
      sfx.land();
      if (o.won) sfx.win(o.target > 0 && 99 / o.target >= BIG_WIN_MULTIPLIER);
      else sfx.lose();
      setLandedId(o.id);
      onSettledRef.current(o);
    };
    if (reduced) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        land();
      });
      return stopLoop;
    }
    const p0 = posRef.current;
    let swing = p0 - o.roll;
    if (Math.abs(swing) < MIN_SWING) {
      // Swing toward whichever side has room.
      swing = o.roll + MIN_SWING <= MAX_ROLL ? MIN_SWING : -MIN_SWING;
    }
    const start = performance.now();
    let lastShown = Math.round(p0);
    let lastSide = Math.round(p0) < o.target;
    const frame = (now: number) => {
      const u = Math.min(1, (now - start) / SETTLE_MS);
      const curve =
        o.roll +
        swing * (1 - u) * Math.exp(-2.6 * u) * Math.cos(2 * Math.PI * 2.25 * u);
      // Blend from wherever the bounce left the ball into the swing.
      const blend = smoothstep(Math.min(1, (now - start) / 160));
      const pos = reflect(p0 + (curve - p0) * blend);
      const shown = Math.round(pos);
      if (shown !== lastShown) {
        const side = shown < o.target;
        if (side !== lastSide) sfx.cross();
        else if (u > 0.35) sfx.tick();
        lastSide = side;
        lastShown = shown;
      }
      paint(pos, shown, o.target);
      if (u < 1) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        rafRef.current = null;
        land();
      }
    };
    rafRef.current = requestAnimationFrame(frame);
    return stopLoop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new outcome id restarts the landing
  }, [outcome?.id]);

  function toggleMute() {
    setMuted(!muted);
    setMutedState(!muted);
  }

  const boundary = (target - 0.5) / MAX_ROLL;
  const nearMiss =
    landed && !landed.won && landed.roll - landed.target < NEAR_MISS;
  const bigWin =
    landed && landed.won && 99 / landed.target >= BIG_WIN_MULTIPLIER;
  const stageState = landed
    ? landed.won
      ? "won"
      : "lost"
    : spinning
      ? "spinning"
      : "idle";

  return (
    <div className={`ds-stage ${stageState}`}>
      <div className="ds-top">
        <button
          type="button"
          className="ds-mute"
          onClick={toggleMute}
          aria-label={muted ? "Unmute sounds" : "Mute sounds"}
        >
          {muted ? "🔇" : "🔊"}
        </button>
      </div>

      <div className="ds-center">
        {landed && (
          <span
            key={landed.id}
            className={`ds-popup ${landed.won ? "won" : "lost"}`}
          >
            {landed.won
              ? `+${shortPiko(landed.payout)} PIKO`
              : `-${shortPiko(landed.stake)} PIKO`}
          </span>
        )}
        <span ref={numberRef} className="ds-number" aria-live="off">
          --
        </span>
        <span className="ds-caption">
          {nearMiss ? (
            <strong className="ds-banner near">So close!</strong>
          ) : bigWin ? (
            <strong className="ds-banner big">Big win!</strong>
          ) : (
            <>
              roll under <strong>{target}</strong> &middot;{" "}
              {multiplier.toFixed(2)}&times;
            </>
          )}
        </span>
      </div>

      <div
        className="ds-lane"
        ref={laneRef}
        style={{ "--b": boundary } as CSSProperties}
      >
        <div className="ds-track" />
        <div className="ds-flag">
          <span>{target}</span>
        </div>
        {TRAIL.map((lag, i) => (
          <div
            key={lag}
            className="ds-ghost"
            ref={(el) => {
              trailRefs.current[i] = el;
            }}
            style={{ opacity: 0.45 - i * 0.1 }}
          />
        ))}
        {/* The in-win/in-lose classes are toggled per frame by paint(); once
            landed, React owns them so a re-render can't wipe the colour. */}
        <div
          className={`ds-ball ${landed ? `landed ${landed.won ? "in-win" : "in-lose"}` : ""}`}
          ref={ballRef}
        />
        {landed && (
          <div
            key={landed.id}
            className={`ds-ripple ${landed.won ? "won" : "lost"}`}
          />
        )}
      </div>
      <div className="ds-scale" aria-hidden="true">
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>99</span>
      </div>

      <div className="ds-bottom">
        <div className="ds-history" aria-label="Your last rolls">
          {history.length === 0 ? (
            <span className="ds-history-empty">
              Your rolls will show up here
            </span>
          ) : (
            history.map((h) => (
              <span key={h.id} className={`ds-pill ${h.won ? "won" : "lost"}`}>
                {String(h.roll).padStart(2, "0")}
              </span>
            ))
          )}
        </div>
        {Math.abs(streak) >= 2 && (
          <span
            key={streak}
            className={`ds-streak ${streak > 0 ? "hot" : "cold"}`}
          >
            {streak > 0 ? `🔥 ${streak} in a row` : `${-streak} lost in a row`}
          </span>
        )}
      </div>
    </div>
  );
}
