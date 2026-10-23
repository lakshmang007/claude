import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import type { TxType } from '../types';
import { BudgetMeter, CategoryBars, ColumnChart, MonthCalendar } from '../components/Charts';
import { Icon } from '../components/Icon';
import { DaySwitcher, MonthSwitcher } from '../components/MonthSwitcher';
import { ScreenHeader } from '../components/ScreenHeader';
import { TransactionList } from '../components/TransactionList';
import { dayLabel, daysInMonth, monthLabel, monthOf, parseISODate, shiftMonth, todayISO } from '../lib/dates';
import { formatMoney, SCALE } from '../lib/money';
import { byCategory, dailyAverage, dailySeries, dailyTotals, inMonth, monthlySeries, newestFirst, totalsFor } from '../lib/stats';
import { useStore } from '../store';

export function Tracker(props: ScreenProps) {
  const { trackerView, setTrackerView, goTab } = props;
  return (
    <div className="screen-inner">
      <ScreenHeader title="Tracker" onSettings={() => goTab('settings')} />
      <div className="segmented" role="radiogroup" aria-label="Track by">
        {(['day', 'month'] as const).map((view) => (
          <button
            key={view}
            role="radio"
            aria-checked={trackerView === view}
            className={trackerView === view ? 'active' : ''}
            onClick={() => setTrackerView(view)}
          >
            {view === 'day' ? 'Daily' : 'Monthly'}
          </button>
        ))}
      </div>
      {trackerView === 'day' ? <DayView {...props} /> : <MonthView {...props} />}
    </div>
  );
}

function DayView({ day, setDay, openTransaction }: ScreenProps) {
  const { transactions, settings } = useStore().data;
  const { currency, monthlyBudget } = settings;
  const today = todayISO();
  const month = monthOf(day);
  const entries = useMemo(() => transactions.filter((tx) => tx.date === day).sort(newestFirst), [transactions, day]);
  const totals = totalsFor(entries);
  const monthSoFar = useMemo(() => totalsFor(inMonth(transactions, month).filter((tx) => tx.date <= day)), [transactions, month, day]);
  const usual = dailyAverage(totalsFor(inMonth(transactions, month)).expense, month);
  const week = useMemo(() => dailySeries(transactions, day, 7), [transactions, day]);
  const difference = totals.expense - usual;
  // In whole units: ₹30,000 over 31 days is ₹968 a day, not ₹967.74.
  const dailyLimit = monthlyBudget ? Math.round(monthlyBudget / daysInMonth(month) / SCALE) * SCALE : null;
  const label = dayLabel(day);
  const named = day === today ? 'today' : label === 'Yesterday' ? 'yesterday' : `on ${label}`;

  return (
    <>
      <DaySwitcher day={day} onChange={setDay} />

      <section className="card balance" aria-label="This day">
        <span className="balance-label">Spent {named}</span>
        <span className="hero-figure">{formatMoney(totals.expense, currency)}</span>
        {usual > 0 && totals.expense > 0 && Math.abs(difference) >= 100 && (
          <span className={`delta ${difference > 0 ? 'delta-bad' : 'delta-good'}`}>
            <Icon name={difference > 0 ? 'up' : 'down'} size={16} />
            {formatMoney(Math.abs(difference), currency)} {difference > 0 ? 'more' : 'less'} than a usual day this month (
            {formatMoney(usual, currency)})
          </span>
        )}
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Added</span>
            <span className="tile-value">{formatMoney(totals.income, currency)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Entries</span>
            <span className="tile-value">{entries.length}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Month so far</span>
            <span className="tile-value">{formatMoney(monthSoFar.expense, currency)}</span>
          </div>
        </div>
      </section>

      {dailyLimit && (
        <section className="card">
          <BudgetMeter label="Daily limit" spent={totals.expense} limit={dailyLimit} currency={currency} />
          <p className="muted meter-note">
            Your monthly budget of {formatMoney(monthlyBudget!, currency)} spread over {daysInMonth(month)} days.
          </p>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>What you spent {named}</h2>
        </div>
        {entries.length ? (
          <TransactionList transactions={entries} onOpen={(tx) => openTransaction(tx.id)} />
        ) : (
          <p className="empty-note card">Nothing recorded {named}.</p>
        )}
      </section>

      <section className="card">
        <h2>Last 7 days</h2>
        <ColumnChart
          label="Spending on each of the last 7 days"
          currency={currency}
          selected={day}
          onSelect={setDay}
          points={week.map((point) => ({
            key: point.date,
            label: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(parseISODate(point.date)),
            title: dayLabel(point.date),
            value: point.expense,
            details: point.income ? [`Added ${formatMoney(point.income, currency)}`] : [],
          }))}
        />
      </section>
    </>
  );
}

function MonthView({ month, setMonth, day, setDay, setTrackerView, showCategory }: ScreenProps) {
  const { transactions, categories, categoryBudgets, settings } = useStore().data;
  const { currency } = settings;
  const [breakdown, setBreakdown] = useState<TxType>('expense');
  const monthTx = useMemo(() => inMonth(transactions, month), [transactions, month]);
  const totals = useMemo(() => totalsFor(monthTx), [monthTx]);
  const previous = useMemo(() => totalsFor(inMonth(transactions, shiftMonth(month, -1))), [transactions, month]);
  const shares = useMemo(() => byCategory(monthTx, categories, breakdown), [monthTx, categories, breakdown]);
  const expenseShares = useMemo(() => byCategory(monthTx, categories, 'expense'), [monthTx, categories]);
  const series = useMemo(() => monthlySeries(transactions, month, 6), [transactions, month]);
  const perDay = useMemo(
    () => new Map([...dailyTotals(transactions, month)].map(([date, t]) => [date, t.expense])),
    [transactions, month],
  );
  const busiest = [...perDay].sort((a, b) => b[1] - a[1])[0];

  const change = previous.expense > 0 ? (totals.expense - previous.expense) / previous.expense : null;
  const budgets = categories
    .filter((c) => categoryBudgets[c.id])
    .map((c) => ({ category: c, limit: categoryBudgets[c.id], spent: expenseShares.find((s) => s.category.id === c.id)?.total ?? 0 }));

  return (
    <>
      <MonthSwitcher month={month} onChange={setMonth} />

      <section className="card balance" aria-label="This month">
        <span className="balance-label">Spent in {monthLabel(month)}</span>
        <span className="hero-figure">{formatMoney(totals.expense, currency)}</span>
        {change !== null && Math.round(change * 100) !== 0 && (
          <span className={`delta ${change > 0 ? 'delta-bad' : 'delta-good'}`}>
            <Icon name={change > 0 ? 'up' : 'down'} size={16} />
            {Math.abs(Math.round(change * 100))}% {change > 0 ? 'more' : 'less'} than {monthLabel(shiftMonth(month, -1), 'short')}
          </span>
        )}
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Added</span>
            <span className="tile-value">{formatMoney(totals.income, currency)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Left over</span>
            <span className="tile-value">{formatMoney(totals.net, currency, { sign: totals.net !== 0 })}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Per day</span>
            <span className="tile-value">{formatMoney(dailyAverage(totals.expense, month), currency)}</span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Day by day</h2>
          {busiest && <span className="muted">Most on {dayLabel(busiest[0])}</span>}
        </div>
        <MonthCalendar
          month={month}
          spent={perDay}
          selected={monthOf(day) === month ? day : null}
          currency={currency}
          onSelect={(date) => {
            setDay(date);
            setTrackerView('day');
          }}
        />
      </section>

      {(settings.monthlyBudget || budgets.length > 0) && (
        <section className="card">
          <h2>Budgets</h2>
          <div className="meters">
            {settings.monthlyBudget && (
              <BudgetMeter label="Everything" spent={totals.expense} limit={settings.monthlyBudget} currency={currency} />
            )}
            {budgets.map(({ category, limit, spent }) => (
              <BudgetMeter key={category.id} label={`${category.icon} ${category.name}`} spent={spent} limit={limit} currency={currency} />
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>{breakdown === 'expense' ? 'Where it went' : 'Where it came from'}</h2>
          <div className="segmented segmented-small" role="radiogroup" aria-label="Breakdown">
            {(['expense', 'income'] as const).map((option) => (
              <button key={option} role="radio" aria-checked={breakdown === option} className={breakdown === option ? 'active' : ''} onClick={() => setBreakdown(option)}>
                {option === 'expense' ? 'Spent' : 'Added'}
              </button>
            ))}
          </div>
        </div>
        {shares.length ? (
          <CategoryBars rows={shares} currency={currency} onSelect={showCategory} />
        ) : (
          <p className="empty-note">Nothing {breakdown === 'expense' ? 'spent' : 'added'} in {monthLabel(month)}.</p>
        )}
      </section>

      <section className="card">
        <h2>Month by month</h2>
        <ColumnChart
          label="Spending in each of the last 6 months"
          currency={currency}
          selected={month}
          onSelect={setMonth}
          points={series.map((point) => ({
            key: point.month,
            label: monthLabel(point.month, 'short'),
            title: monthLabel(point.month),
            value: point.expense,
            details: [`Added ${formatMoney(point.income, currency)}`],
          }))}
        />
        <table className="month-table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Added</th>
              <th scope="col">Spent</th>
              <th scope="col">Left over</th>
            </tr>
          </thead>
          <tbody>
            {[...series].reverse().map((point) => (
              <tr key={point.month} className={point.month === month ? 'selected' : ''} onClick={() => setMonth(point.month)}>
                <th scope="row">{monthLabel(point.month, 'short')}</th>
                <td>{formatMoney(point.income, currency)}</td>
                <td>{formatMoney(point.expense, currency)}</td>
                <td>{formatMoney(point.net, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
