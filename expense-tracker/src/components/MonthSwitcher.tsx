import { currentMonth, dayLabel, monthLabel, parseISODate, shiftMonth, todayISO, toISODate } from '../lib/dates';
import { Icon } from './Icon';

export function MonthSwitcher({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const isCurrent = month === currentMonth();
  return (
    <div className="month-switcher">
      <button className="icon-btn" onClick={() => onChange(shiftMonth(month, -1))} aria-label="Previous month">
        <Icon name="left" />
      </button>
      <button
        className="month-label"
        onClick={() => onChange(currentMonth())}
        disabled={isCurrent}
        aria-label={isCurrent ? monthLabel(month) : `${monthLabel(month)}, go to this month`}
      >
        {monthLabel(month)}
        {!isCurrent && <span className="month-today">This month</span>}
      </button>
      <button className="icon-btn" onClick={() => onChange(shiftMonth(month, 1))} aria-label="Next month">
        <Icon name="right" />
      </button>
    </div>
  );
}

export function DaySwitcher({ day, onChange }: { day: string; onChange: (day: string) => void }) {
  const today = todayISO();
  const shift = (delta: number) => {
    const date = parseISODate(day);
    onChange(toISODate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)));
  };
  const label = day === today ? 'Today' : dayLabel(day);
  return (
    <div className="month-switcher">
      <button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous day">
        <Icon name="left" />
      </button>
      <button
        className="month-label"
        onClick={() => onChange(today)}
        disabled={day === today}
        aria-label={day === today ? 'Today' : `${label}, go to today`}
      >
        {label}
        {day !== today && <span className="month-today">Today</span>}
      </button>
      <button className="icon-btn" onClick={() => shift(1)} aria-label="Next day" disabled={day >= today}>
        <Icon name="right" />
      </button>
    </div>
  );
}
