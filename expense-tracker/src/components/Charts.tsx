import { useLayoutEffect, useRef, useState } from 'react';
import type { CategoryShare, MonthPoint } from '../lib/stats';
import { budgetLevel } from '../lib/stats';
import { monthLabel } from '../lib/dates';
import { formatMoney, SCALE } from '../lib/money';
import { Icon } from './Icon';

/** Category totals as a ranked list of thin bars, each labelled with its amount and share. */
export function CategoryBars({
  rows,
  currency,
  onSelect,
  limit,
}: {
  rows: CategoryShare[];
  currency: string;
  onSelect?: (categoryId: string) => void;
  limit?: number;
}) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const max = shown[0]?.total ?? 0;
  return (
    <ul className="cat-bars">
      {shown.map((row) => (
        <li key={row.category.id}>
          <button className="cat-bar" onClick={() => onSelect?.(row.category.id)} disabled={!onSelect}>
            <span className="cat-bar-head">
              <span className="cat-bar-name">
                <span aria-hidden="true">{row.category.icon}</span> {row.category.name}
              </span>
              <span className="cat-bar-value">
                {formatMoney(row.total, currency)}
                <span className="cat-bar-share">{Math.round(row.share * 100)}%</span>
              </span>
            </span>
            <span className="cat-bar-track" aria-hidden="true">
              <span className="cat-bar-fill" style={{ width: `${max > 0 ? Math.max(1.5, (row.total / max) * 100) : 0}%` }} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A clean axis maximum and step covering `max` (in whole currency units) with about three ticks. */
export function niceScale(max: number, ticks = 3): { top: number; step: number } {
  if (max <= 0) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  return { top: Math.ceil(max / step) * step, step };
}

function columnPath(x: number, y: number, width: number, base: number): string {
  const r = Math.min(4, base - y, width / 2);
  if (r <= 0) return '';
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${base}Z`;
}

/** Monthly spending as columns; the selected month is the accent and carries the only value label. */
export function MonthlyColumns({
  points,
  selected,
  currency,
  onSelect,
}: {
  points: MonthPoint[];
  selected: string;
  currency: string;
  onSelect: (month: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const height = 180;
  const top = 22;
  const bottom = 24;
  const left = 44;
  const base = height - bottom;
  const { top: maxUnits, step } = niceScale(Math.max(...points.map((p) => p.expense)) / SCALE);
  const ticks = Array.from({ length: Math.round(maxUnits / step) + 1 }, (_, i) => i * step);
  const plot = Math.max(0, width - left);
  const band = points.length ? plot / points.length : 0;
  const barWidth = Math.min(24, band * 0.5);
  const y = (units: number) => base - (units / maxUnits) * (base - top);
  const hovered = points.find((p) => p.month === hover);

  return (
    <div className="columns" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Spending in each of the last months">
          {ticks.map((tick) => (
            <g key={tick}>
              <line className={tick === 0 ? 'axis-base' : 'grid'} x1={left} x2={width} y1={y(tick)} y2={y(tick)} />
              <text className="tick" x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {formatMoney(tick * SCALE, currency, { compact: true })}
              </text>
            </g>
          ))}
          {points.map((point, i) => {
            const cx = left + band * i + band / 2;
            const units = point.expense / SCALE;
            const isSelected = point.month === selected;
            return (
              <g
                key={point.month}
                className="column-hit"
                onClick={() => onSelect(point.month)}
                onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(point.month)}
                onPointerLeave={() => setHover(null)}
              >
                <rect x={cx - band / 2} y={top - 20} width={band} height={height - top + 20} fill="transparent" />
                <path className={isSelected ? 'column selected' : 'column'} d={columnPath(cx - barWidth / 2, y(units), barWidth, base)} />
                {isSelected && point.expense > 0 && (
                  <text className="column-value" x={cx} y={y(units) - 6} textAnchor="middle">
                    {formatMoney(point.expense, currency, { compact: true })}
                  </text>
                )}
                <text className={isSelected ? 'tick tick-selected' : 'tick'} x={cx} y={height - 6} textAnchor="middle">
                  {monthLabel(point.month, 'short')}
                </text>
                <title>{`${monthLabel(point.month)}: spent ${formatMoney(point.expense, currency)}`}</title>
              </g>
            );
          })}
        </svg>
      )}
      {hovered && (
        <div
          className="chart-tip"
          style={{ left: Math.min(Math.max(left + band * points.indexOf(hovered) + band / 2, 80), width - 80) }}
          role="presentation"
        >
          <strong>{monthLabel(hovered.month)}</strong>
          <span>Spent {formatMoney(hovered.expense, currency)}</span>
          <span>Earned {formatMoney(hovered.income, currency)}</span>
        </div>
      )}
    </div>
  );
}

/** Spending against a limit. The fill turns warning at 80% and critical past 100%, always with a label. */
export function BudgetMeter({ label, spent, limit, currency }: { label: string; spent: number; limit: number; currency: string }) {
  const level = budgetLevel(spent, limit);
  const used = limit > 0 ? spent / limit : 0;
  return (
    <div className={`meter meter-${level}`}>
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">
          {level === 'over'
            ? `${formatMoney(spent - limit, currency)} over`
            : `${formatMoney(limit - spent, currency)} left`}
        </span>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit / SCALE}
        aria-valuenow={Math.min(spent, limit) / SCALE}
        aria-valuetext={`${formatMoney(spent, currency)} of ${formatMoney(limit, currency)}`}
      >
        <div className="meter-fill" style={{ width: `${Math.min(100, used * 100)}%` }} />
      </div>
      <div className="meter-foot">
        <span>
          {formatMoney(spent, currency)} of {formatMoney(limit, currency)}
        </span>
        {level !== 'ok' && (
          <span className="meter-status">
            <Icon name="alert" size={14} />
            {level === 'over' ? 'Over budget' : `${Math.round(used * 100)}% used`}
          </span>
        )}
      </div>
    </div>
  );
}
