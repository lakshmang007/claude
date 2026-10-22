import { useMemo } from 'react';
import type { ScreenProps } from '../App';
import { BudgetMeter, CategoryBars } from '../components/Charts';
import { Icon } from '../components/Icon';
import { MonthSwitcher } from '../components/MonthSwitcher';
import { TransactionList } from '../components/TransactionList';
import { formatMoney, currencyLabel, CURRENCIES } from '../lib/money';
import { sampleTransactions } from '../lib/sample';
import { byCategory, inMonth, newestFirst, totalsFor } from '../lib/stats';
import { useStore } from '../store';

export function Home({ month, setMonth, openTransaction, addTransaction, showCategory, goTab }: ScreenProps) {
  const store = useStore();
  const { transactions, categories, settings } = store.data;
  const monthTx = useMemo(() => inMonth(transactions, month), [transactions, month]);
  const totals = useMemo(() => totalsFor(monthTx), [monthTx]);
  const spending = useMemo(() => byCategory(monthTx, categories, 'expense'), [monthTx, categories]);
  const recent = useMemo(() => [...monthTx].sort(newestFirst).slice(0, 6), [monthTx]);
  const { currency } = settings;

  if (transactions.length === 0) {
    return (
      <div className="screen-inner">
        <header className="screen-header">
          <h1>Expense Tracker</h1>
        </header>
        <section className="card welcome">
          <div className="welcome-art" aria-hidden="true">
            👛
          </div>
          <h2>Know where your money goes</h2>
          <p>Add what you spend and earn. Everything stays on this phone and works offline.</p>
          <label className="field">
            <span>Your currency</span>
            <select value={currency} onChange={(event) => store.updateSettings({ currency: event.target.value })}>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {currencyLabel(code)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary btn-block" onClick={() => addTransaction('expense')}>
            <Icon name="plus" size={20} /> Add your first expense
          </button>
          <button
            className="btn btn-ghost btn-block"
            onClick={() => store.replaceAll({ ...store.data, transactions: sampleTransactions(currency) })}
          >
            <Icon name="sparkle" size={18} /> Try it with sample data
          </button>
        </section>
      </div>
    );
  }

  const budget = settings.monthlyBudget;

  return (
    <div className="screen-inner">
      <header className="screen-header">
        <h1>Expense Tracker</h1>
      </header>
      <MonthSwitcher month={month} onChange={setMonth} />

      <section className="card balance" aria-label="This month">
        <span className="balance-label">Balance</span>
        <span className="hero-figure">{formatMoney(totals.net, currency, { sign: totals.net !== 0 })}</span>
        <div className="balance-split">
          <button className="balance-part" onClick={() => addTransaction('income')} aria-label="Income, add income">
            <span className="balance-part-label">
              <span className="dot dot-income" aria-hidden="true" />
              Income
            </span>
            <span className="balance-part-value">{formatMoney(totals.income, currency)}</span>
          </button>
          <button className="balance-part" onClick={() => addTransaction('expense')} aria-label="Spent, add expense">
            <span className="balance-part-label">
              <span className="dot dot-expense" aria-hidden="true" />
              Spent
            </span>
            <span className="balance-part-value">{formatMoney(totals.expense, currency)}</span>
          </button>
        </div>
      </section>

      {budget ? (
        <section className="card">
          <BudgetMeter label="Monthly budget" spent={totals.expense} limit={budget} currency={currency} />
        </section>
      ) : (
        <button className="card card-link" onClick={() => goTab('settings')}>
          <span>Set a monthly budget</span>
          <Icon name="right" size={18} />
        </button>
      )}

      {spending.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Top spending</h2>
            <button className="link-btn" onClick={() => goTab('stats')}>
              Stats
            </button>
          </div>
          <CategoryBars rows={spending} currency={currency} limit={4} onSelect={showCategory} />
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Recent</h2>
          {monthTx.length > recent.length && (
            <button className="link-btn" onClick={() => goTab('transactions')}>
              See all {monthTx.length}
            </button>
          )}
        </div>
        {recent.length ? (
          <TransactionList transactions={recent} onOpen={(tx) => openTransaction(tx.id)} />
        ) : (
          <p className="empty-note card">Nothing recorded this month yet.</p>
        )}
      </section>
    </div>
  );
}
