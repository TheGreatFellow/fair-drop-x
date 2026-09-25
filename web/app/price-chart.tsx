"use client";

import { useState } from "react";

type Props = {
  prices: number[]; // yen, index i = price of the (i+1)th sale
  sold: number; // next unit to sell is index `sold`
  flatUnits: number;
};

const W = 520;
const H = 260;
const PAD = { top: 22, right: 12, bottom: 38, left: 58 };
const FONT = 12;
const yen = (n: number) => `¥${Math.round(n).toLocaleString("ja-JP")}`;

/**
 * The project's whole argument in one picture: a flat fan price, then demand pricing. One data
 * series, so no legend box — the title names it.
 */
export function PriceChart({ prices, sold, flatUnits }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const n = prices.length;
  // Round tick steps (¥5k / ¥10k …) instead of quarters of an arbitrary max.
  const top = Math.max(...prices) * 1.1;
  const tickStep = [1000, 2000, 5000, 10000, 20000, 50000].find((t) => top / t <= 5) ?? 100000;
  const yMax = Math.ceil(top / tickStep) * tickStep;
  const x = (i: number) => PAD.left + ((i + 0.5) / n) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / yMax) * (H - PAD.top - PAD.bottom);
  const step = (W - PAD.left - PAD.right) / n;
  const ticks = Array.from({ length: yMax / tickStep + 1 }, (_, k) => k * tickStep);
  const path = prices.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join("");
  const next = Math.min(sold, n - 1);
  const shown = hover ?? next;

  return (
    <figure className="viz-root m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label={`Price per unit. First ${flatUnits} at ${yen(prices[0])}, rising to ${yen(prices[n - 1])}.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={FONT} fill="var(--muted)"
              style={{ fontVariantNumeric: "tabular-nums" }}>{yen(t)}</text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--axis)" strokeWidth={1} />
        {[0, flatUnits - 1, n - 1].map((i) => (
          <text key={i} x={x(i)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize={FONT} fill="var(--muted)">#{i + 1}</text>
        ))}
        <text x={(PAD.left + W - PAD.right) / 2} y={H - 4} textAnchor="middle" fontSize={FONT} fill="var(--muted)">Unit number (order of sale)</text>

        {/* Units already sold sit under a soft band; the unsold rest of the curve stays open. */}
        {sold > 0 && (
          <rect x={PAD.left} y={PAD.top} width={Math.min(sold, n) * step} height={H - PAD.top - PAD.bottom} fill="var(--series-1)" opacity={0.06} />
        )}
        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <text x={x(0)} y={y(prices[0]) - 10} fontSize={FONT + 1} fill="var(--text-secondary)">Fan price</text>
        {flatUnits < n && (
          <text x={x(flatUnits) + 4} y={y(prices[flatUnits]) + 20} fontSize={FONT + 1} fill="var(--text-secondary)">Demand pricing →</text>
        )}

        {sold < n && (
          <circle cx={x(next)} cy={y(prices[next])} r={6} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={2} />
        )}

        {/* Hit targets wider than the marks: one full column per unit. */}
        {prices.map((p, i) => (
          <rect key={i} x={x(i) - step / 2} y={PAD.top} width={step} height={H - PAD.top - PAD.bottom} fill="transparent"
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
        ))}
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--axis)" strokeWidth={1} pointerEvents="none" />
        )}
      </svg>
      <figcaption className="mt-1 text-sm" style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
        Unit #{shown + 1}: <strong style={{ color: "var(--text-primary)" }}>{yen(prices[shown])}</strong>
        {shown < sold ? " · sold" : shown === next ? " · next to sell" : ""}
      </figcaption>
    </figure>
  );
}
