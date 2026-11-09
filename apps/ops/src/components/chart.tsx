'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAmount } from '@/lib/format';
import { bucketLabel, dateTimeShort } from '@/lib/time';
import { cx } from './ui';

const IN = '#0a84ff';
const OUT = '#eb6834';

function niceStep(max: number): number {
  if (max <= 0) return 1;
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
  return `${Math.round(v * 100) / 100}`;
}

function bar(x: number, w: number, y0: number, y1: number, up: boolean): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(4, w / 2, h);
  if (up) return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

export function FlowChart({ series, bucket, currency, decimals, height = 220 }: { series: { at: string; inflow: string; outflow: string }[]; bucket: 'hour' | 'day'; currency: string; decimals: number; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = 10 ** decimals;
  const pts = useMemo(() => series.map((s) => ({ at: s.at, inflow: Number(BigInt(s.inflow)) / scale, outflow: Number(BigInt(s.outflow)) / scale, rawIn: s.inflow, rawOut: s.outflow })), [series, scale]);
  const maxIn = Math.max(0, ...pts.map((p) => p.inflow));
  const maxOut = Math.max(0, ...pts.map((p) => p.outflow));
  const step = niceStep(Math.max(maxIn, maxOut, 1));
  const top = Math.max(step, Math.ceil(maxIn / step) * step);
  const bottom = maxOut > 0 ? Math.max(step, Math.ceil(maxOut / step) * step) : 0;

  const padL = 52;
  const padR = 8;
  const padT = 10;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const span = top + bottom;
  const y = (v: number) => padT + ((top - v) / span) * plotH;
  const base = y(0);
  const band = plotW / Math.max(1, pts.length);
  const colW = Math.min(24, Math.max(3, band * 0.56));
  const ticks: number[] = [];
  for (let v = -bottom; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  const labelEvery = Math.ceil(pts.length / Math.max(2, Math.floor(plotW / 64)));
  const h = hover !== null ? pts[hover] : null;
  const empty = maxIn === 0 && maxOut === 0;

  return (
    <div ref={wrap} className="relative select-none">
      <svg width={width} height={height} role="img" aria-label={`Customer USDC received and sent per ${bucket}`} className="block overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#c9c9d1' : 'var(--color-chart-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={padL - 10} y={y(t)} dy="0.32em" textAnchor="end" className="tnum fill-subtle text-[11px]">
              {compact(Math.abs(t))}
            </text>
          </g>
        ))}
        {pts.map((p, i) => {
          const x = padL + i * band + (band - colW) / 2;
          const dim = hover !== null && hover !== i;
          return (
            <g key={p.at} opacity={dim ? 0.45 : 1}>
              {p.inflow > 0 && <path d={bar(x, colW, base - 1, y(p.inflow), true)} fill={IN} />}
              {p.outflow > 0 && <path d={bar(x, colW, base + 1, y(-p.outflow), false)} fill={OUT} />}
              {i % labelEvery === 0 && (
                <text x={padL + i * band + band / 2} y={height - 8} textAnchor="middle" className="tnum fill-subtle text-[11px]">
                  {bucketLabel(p.at, bucket)}
                </text>
              )}
              <rect
                x={padL + i * band}
                y={padT}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${dateTimeShort(p.at)}: received ${formatAmount(p.rawIn, currency)}, sent ${formatAmount(p.rawOut, currency)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              />
            </g>
          );
        })}
        {empty && (
          <text x={padL + plotW / 2} y={padT + plotH / 2} textAnchor="middle" className="fill-muted text-[12px]">
            No customer USDC moved in this window
          </text>
        )}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 w-52 rounded-md border border-line bg-surface px-3 py-2 shadow-pop"
          style={{ left: Math.min(width - 216, Math.max(0, padL + hover * band + band / 2 - 104)) }}
        >
          <div className="text-xs text-muted">{bucket === 'hour' ? dateTimeShort(h.at) : bucketLabel(h.at, 'day')}</div>
          {[
            { k: 'Received', v: h.rawIn, c: IN },
            { k: 'Sent', v: h.rawOut, c: OUT },
          ].map((r) => (
            <div key={r.k} className="mt-1 flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-muted">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: r.c }} />
                {r.k}
              </span>
              <span className="tnum font-semibold text-ink">{formatAmount(r.v, currency)}</span>
            </div>
          ))}
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-1 text-sm">
            <span className="text-muted">Net</span>
            <span className="tnum font-medium text-ink-2">{formatAmount((BigInt(h.rawIn) - BigInt(h.rawOut)).toString(), currency)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function Legend({ items, className }: { items: { label: string; color: string }[]; className?: string }) {
  return (
    <div className={cx('flex items-center gap-4 text-xs text-muted', className)}>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export const FLOW_COLORS = { in: IN, out: OUT };
