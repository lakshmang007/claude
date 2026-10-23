import { useLayoutEffect, useRef, useState } from 'react';
import type { CategoryShare } from '../lib/stats';
import { budgetLevel } from '../lib/stats';
import { dayLabel, daysInMonth, monthLabel, todayISO } from '../lib/dates';
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

export interface ColumnPoint {
  key: string;
  /** Under the column: "Oct", "Mon". */
  label: string;
  /** Full name for the tooltip: "October 2026", "Mon, 20 Oct". */
  title: string;
  /** Spending, in hundredths. */
  value: number;
  /** More lines for the tooltip. */
  details?: string[];
}

/** Spending as columns; the selected one is the accent and carries the only value label. */
export function ColumnChart({
  points,
  selected,
  currency,
  onSelect,
  label,
}: {
  points: ColumnPoint[];
  selected: string;
  currency: string;
  onSelect: (key: string) => void;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const height = 180;
  const top = 22;
  const bottom = 24;
  const left = 44;
  const base = height - bottom;
  const { top: maxUnits, step } = niceScale(Math.max(...points.map((p) => p.value)) / SCALE);
  const ticks = Array.from({ length: Math.round(maxUnits / step) + 1 }, (_, i) => i * step);
  const plot = Math.max(0, width - left);
  const band = points.length ? plot / points.length : 0;
  const barWidth = Math.min(24, band * 0.5);
  const y = (units: number) => base - (units / maxUnits) * (base - top);
  const hovered = points.find((p) => p.key === hover);

  return (
    <div className="columns" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
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
            const units = point.value / SCALE;
            const isSelected = point.key === selected;
            return (
              <g
                key={point.key}
                className="column-hit"
                onClick={() => onSelect(point.key)}
                onPointerEnter={(event) => event.pointerType === 'mouse' && setHover(point.key)}
                onPointerLeave={() => setHover(null)}
              >
                <rect x={cx - band / 2} y={top - 20} width={band} height={height - top + 20} fill="transparent" />
                <path className={isSelected ? 'column selected' : 'column'} d={columnPath(cx - barWidth / 2, y(units), barWidth, base)} />
                {isSelected && point.value > 0 && (
                  <text className="column-value" x={cx} y={y(units) - 6} textAnchor="middle">
                    {formatMoney(point.value, currency, { compact: true })}
                  </text>
                )}
                <text className={isSelected ? 'tick tick-selected' : 'tick'} x={cx} y={height - 6} textAnchor="middle">
                  {point.label}
                </text>
                <title>{`${point.title}: spent ${formatMoney(point.value, currency)}`}</title>
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
          <strong>{hovered.title}</strong>
          <span>Spent {formatMoney(hovered.value, currency)}</span>
          {hovered.details?.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** Four steps of one hue by share of the busiest day; zero stays empty. */
export function heatLevel(value: number, max: number): HeatLevel {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as HeatLevel;
}

/**
 * A month as a calendar: each day shows what was spent, shaded by how much. Tapping a day
 * selects it. Weeks start on the locale's first day.
 */
export function MonthCalendar({
  month,
  spent,
  selected,
  currency,
  onSelect,
}: {
  month: string;
  /** Spending per YYYY-MM-DD. */
  spent: Map<string, number>;
  selected: string | null;
  currency: string;
  onSelect: (date: string) => void;
}) {
  const [year, monthIndex] = month.split('-').map(Number);
  const firstDay = weekStart();
  const offset = (new Date(year, monthIndex - 1, 1).getDay() - (firstDay % 7) + 7) % 7;
  const days = daysInMonth(month);
  const today = todayISO();
  const max = Math.max(0, ...spent.values());
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(2024, 0, 7 + ((firstDay + i) % 7))),
  );

  return (
    <div className="calendar">
      <div className="calendar-grid" role="group" aria-label={`Spending each day of ${monthLabel(month)}`}>
        {weekdays.map((name, i) => (
          <span key={i} className="calendar-weekday" aria-hidden="true">
            {name}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`blank-${i}`} aria-hidden="true" />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, '0')}`;
          const value = spent.get(date) ?? 0;
          const level = heatLevel(value, max);
          return (
            <button
              key={date}
              className={`calendar-day heat-${level} ${date === selected ? 'selected' : ''} ${date === today ? 'today' : ''}`}
              onClick={() => onSelect(date)}
              aria-label={`${dayLabel(date)}: ${value ? `spent ${formatMoney(value, currency)}` : 'nothing spent'}`}
              aria-pressed={date === selected}
              disabled={date > today}
            >
              <span className="calendar-date">{i + 1}</span>
              {value > 0 && <span className="calendar-amount">{formatMoney(value, currency, { compact: true })}</span>}
            </button>
          );
        })}
      </div>
      <div className="calendar-legend" aria-hidden="true">
        <span>Less</span>
        {([1, 2, 3, 4] as const).map((level) => (
          <span key={level} className={`calendar-swatch heat-${level}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/** The first day of the week for the person's locale, 0 = Sunday … 6 = Saturday (default Monday). */
function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const firstDay = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    return firstDay ? firstDay % 7 : 1;
  } catch {
    return 1;
  }
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
