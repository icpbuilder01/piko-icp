import { useEffect, useRef, useState } from "react";
import { formatHashrate } from "../lib/format";

export interface HashratePoint {
  // Window end, ms since epoch.
  time: number;
  hashesPerSecond: number;
  blocks: number;
  difficultyBits: number;
  // The still-open current window, not a recorded one.
  live: boolean;
}

const HEIGHT = 220;
const PAD = { top: 14, right: 16, bottom: 26, left: 64 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * exp >= v) return m * exp;
  }
  return 10 * exp;
}

function formatTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs < 2 * 86_400_000) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Single-series line chart of estimated network hashrate, one point per
// retarget window. Hand-rolled SVG (no chart library in this project);
// width tracks the container so text never gets stretched by a viewBox.
function HashrateChart({ points }: { points: HashratePoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length < 2) {
    return (
      <div className="empty-state">
        Hashrate history is recorded once per retarget window (every 10 blocks, ~50 min) --
        the chart appears after the first couple of windows.
      </div>
    );
  }

  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const t0 = points[0].time;
  const t1 = points[points.length - 1].time;
  const span = Math.max(1, t1 - t0);
  const yMax = niceMax(Math.max(...points.map((p) => p.hashesPerSecond)));
  const x = (t: number) => PAD.left + ((t - t0) / span) * innerW;
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;

  const recorded = points.filter((p) => !p.live);
  const linePath = recorded.map((p, i) => `${i ? "L" : "M"}${x(p.time)},${y(p.hashesPerSecond)}`).join("");
  const last = points[points.length - 1];
  const prevRecorded = recorded[recorded.length - 1];
  const livePath =
    last.live && prevRecorded
      ? `M${x(prevRecorded.time)},${y(prevRecorded.hashesPerSecond)}L${x(last.time)},${y(last.hashesPerSecond)}`
      : null;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const xTickCount = Math.max(2, Math.min(6, Math.floor(innerW / 110)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + (span * i) / (xTickCount - 1));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(x(points[i].time) - px) < Math.abs(x(points[best].time) - px)) best = i;
    }
    setHover(best);
  }

  const hp = hover !== null ? points[hover] : null;
  const tipLeft = hp ? Math.min(Math.max(x(hp.time), 90), width - 90) : 0;

  return (
    <div className="hashrate-chart" ref={wrapRef}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Estimated network hashrate over time, latest ${formatHashrate(last.hashesPerSecond)}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line className="hc-grid" x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="hc-tick" x={PAD.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {v === 0 ? "0" : formatHashrate(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} className="hc-tick" x={x(t)} y={HEIGHT - 6} textAnchor="middle">
            {formatTick(t, span)}
          </text>
        ))}
        <path className="hc-line" d={linePath} />
        {livePath && <path className="hc-line hc-line-live" d={livePath} />}
        {hp && (
          <>
            <line className="hc-crosshair" x1={x(hp.time)} x2={x(hp.time)} y1={PAD.top} y2={PAD.top + innerH} />
            <circle className="hc-dot" cx={x(hp.time)} cy={y(hp.hashesPerSecond)} r={5} />
          </>
        )}
      </svg>
      {hp && (
        <div className="hc-tooltip" style={{ left: tipLeft }}>
          <strong>~{formatHashrate(hp.hashesPerSecond)}</strong>
          <span>{new Date(hp.time).toLocaleString()}</span>
          <span>
            {hp.live ? "current window, in progress" : `${hp.blocks} blocks`} · {hp.difficultyBits} bits
          </span>
        </div>
      )}
    </div>
  );
}

export default HashrateChart;
