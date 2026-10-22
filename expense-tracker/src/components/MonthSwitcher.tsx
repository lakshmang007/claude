import { currentMonth, monthLabel, shiftMonth } from '../lib/dates';
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
