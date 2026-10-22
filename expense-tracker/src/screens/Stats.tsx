import { useMemo, useState } from 'react';
import type { ScreenProps } from '../App';
import type { TxType } from '../types';
import { BudgetMeter, CategoryBars, MonthlyColumns } from '../components/Charts';
import { Icon } from '../components/Icon';
import { MonthSwitcher } from '../components/MonthSwitcher';
import { monthLabel, shiftMonth } from '../lib/dates';
import { formatMoney } from '../lib/money';
import { byCategory, dailyAverage, inMonth, monthlySeries, totalsFor } from '../lib/stats';
import { useStore } from '../store';

export function Stats({ month, setMonth, showCategory }: ScreenProps) {
  const { transactions, categories, categoryBudgets, settings } = useStore().data;
  const { currency } = settings;
  const [breakdown, setBreakdown] = useState<TxType>('expense');
  const monthTx = useMemo(() => inMonth(transactions, month), [transactions, month]);
  const totals = useMemo(() => totalsFor(monthTx), [monthTx]);
  const previous = useMemo(() => totalsFor(inMonth(transactions, shiftMonth(month, -1))), [transactions, month]);
  const shares = useMemo(() => byCategory(monthTx, categories, breakdown), [monthTx, categories, breakdown]);
  const expenseShares = useMemo(() => byCategory(monthTx, categories, 'expense'), [monthTx, categories]);
  const series = useMemo(() => monthlySeries(transactions, month, 6), [transactions, month]);

  const change = previous.expense > 0 ? (totals.expense - previous.expense) / previous.expense : null;
  const budgets = categories
    .filter((c) => categoryBudgets[c.id])
    .map((c) => ({ category: c, limit: categoryBudgets[c.id], spent: expenseShares.find((s) => s.category.id === c.id)?.total ?? 0 }));

  return (
    <div className="screen-inner">
      <header className="screen-header">
        <h1>Stats</h1>
      </header>
      <MonthSwitcher month={month} onChange={setMonth} />

      <section className="card balance">
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
            <span className="tile-label">Income</span>
            <span className="tile-value">{formatMoney(totals.income, currency)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Saved</span>
            <span className="tile-value">{formatMoney(totals.net, currency)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Per day</span>
            <span className="tile-value">{formatMoney(dailyAverage(totals.expense, month), currency)}</span>
          </div>
        </div>
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
                {option === 'expense' ? 'Spent' : 'Earned'}
              </button>
            ))}
          </div>
        </div>
        {shares.length ? (
          <CategoryBars rows={shares} currency={currency} onSelect={showCategory} />
        ) : (
          <p className="empty-note">Nothing {breakdown === 'expense' ? 'spent' : 'earned'} in {monthLabel(month)}.</p>
        )}
      </section>

      <section className="card">
        <h2>Spending by month</h2>
        <MonthlyColumns points={series} selected={month} currency={currency} onSelect={setMonth} />
        <table className="month-table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Earned</th>
              <th scope="col">Spent</th>
              <th scope="col">Saved</th>
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
    </div>
  );
}
