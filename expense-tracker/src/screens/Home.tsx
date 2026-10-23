import { useMemo } from 'react';
import type { ScreenProps } from '../App';
import { BudgetMeter, CategoryBars } from '../components/Charts';
import { Icon } from '../components/Icon';
import { MonthSwitcher } from '../components/MonthSwitcher';
import { ScreenHeader } from '../components/ScreenHeader';
import { TransactionList } from '../components/TransactionList';
import { formatMoney, currencyLabel, CURRENCIES } from '../lib/money';
import { todayISO } from '../lib/dates';
import { debtTotals } from '../lib/people';
import { sampleDebts, sampleOpeningBalance, sampleSavings, sampleTransactions } from '../lib/sample';
import { byCategory, inMonth, newestFirst, totalsFor } from '../lib/stats';
import { useStore } from '../store';

export function Home(props: ScreenProps) {
  const { month, setMonth, openTransaction, addTransaction, showCategory, goTab, openBalance, openSaving, setDay, setTrackerView } = props;
  const store = useStore();
  const { transactions, categories, settings } = store.data;
  const monthTx = useMemo(() => inMonth(transactions, month), [transactions, month]);
  const totals = useMemo(() => totalsFor(monthTx), [monthTx]);
  const spending = useMemo(() => byCategory(monthTx, categories, 'expense'), [monthTx, categories]);
  const recent = useMemo(() => [...monthTx].sort(newestFirst).slice(0, 6), [monthTx]);
  const { currency, monthlyBudget } = settings;
  const { now: money, saved } = store.balances;
  const started = transactions.length > 0 || settings.openingBalance !== 0;
  // Getting started gives way once anything is recorded.
  const hasActivity = transactions.length > 0 || store.data.debts.length > 0 || store.data.savings.length > 0;
  const today = todayISO();
  const spentToday = useMemo(() => totalsFor(transactions.filter((tx) => tx.date === today)), [transactions, today]);
  const owed = useMemo(() => debtTotals(store.data.debts), [store.data.debts]);
  const openTracker = (view: 'day' | 'month') => {
    if (view === 'day') setDay(today);
    setTrackerView(view);
    goTab('tracker');
  };

  return (
    <div className="screen-inner">
      <ScreenHeader title="Expense Tracker" onSettings={() => goTab('settings')} />

      <section className="card wallet" aria-label="Money you have">
        <div className="wallet-head">
          <span className="balance-label">Money you have</span>
          <button className="link-btn" onClick={openBalance}>
            {started ? 'Change' : 'Set amount'}
          </button>
        </div>
        <span className={`hero-figure ${money < 0 ? 'negative' : ''}`}>{formatMoney(money, currency)}</span>
        {money < 0 && (
          <span className="wallet-warning">
            <Icon name="alert" size={16} /> You have spent more than you had
          </span>
        )}
        {saved > 0 && (
          <button className="wallet-split" onClick={() => goTab('savings')}>
            <span>
              <Icon name="jar" size={16} /> In savings <strong>{formatMoney(saved, currency)}</strong>
            </span>
            <span>
              Free to spend <strong>{formatMoney(money - saved, currency)}</strong>
            </span>
          </button>
        )}
        <div className="wallet-actions">
          <button className="btn btn-money-in" onClick={() => addTransaction('income')}>
            <Icon name="plus" size={20} /> Add money
          </button>
          <button className="btn btn-money-out" onClick={() => addTransaction('expense')}>
            <Icon name="minus" size={20} /> Add expense
          </button>
          <button className="btn btn-craving" onClick={() => openSaving()}>
            <Icon name="jar" size={20} /> Skipped a craving? Save it
          </button>
        </div>
      </section>

      {!hasActivity ? (
        <section className="card welcome">
          <h2>Get started</h2>
          <ol className="steps">
            <li>
              Set the <strong>money you have</strong> right now.
            </li>
            <li>
              Tap <strong>Add money</strong> when money comes in. It is added to your total.
            </li>
            <li>
              Tap <strong>Add expense</strong> when you spend. It is taken off your total.
            </li>
            <li>
              Didn't buy something you wanted? Tap <strong>Skipped a craving</strong> and its price goes into your savings.
            </li>
          </ol>
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
          <p className="muted">Everything stays on this phone and works offline.</p>
          <button
            className="btn btn-ghost btn-block"
            onClick={() =>
              store.replaceAll({
                ...store.data,
                transactions: sampleTransactions(currency),
                savings: sampleSavings(currency),
                debts: sampleDebts(currency),
                settings: { ...settings, openingBalance: sampleOpeningBalance(currency) },
              })
            }
          >
            <Icon name="sparkle" size={18} /> Try it with sample data
          </button>
        </section>
      ) : (
        <>
          <button className="card card-link today-link" onClick={() => openTracker('day')}>
            <span>
              Spent today <strong>{formatMoney(spentToday.expense, currency)}</strong>
              {spentToday.count > 0 && <span className="muted"> · {spentToday.count} {spentToday.count === 1 ? 'entry' : 'entries'}</span>}
            </span>
            <span className="link-label">
              Daily tracker <Icon name="right" size={18} />
            </span>
          </button>

          {(owed.toGet > 0 || owed.toGive > 0) && (
            <button className="card card-link" onClick={() => goTab('people')}>
              <span className="owed-line">
                {owed.toGet > 0 && (
                  <span>
                    To get back <strong className="owed-to-you">{formatMoney(owed.toGet, currency)}</strong>
                  </span>
                )}
                {owed.toGive > 0 && (
                  <span>
                    To give <strong className="you-owe">{formatMoney(owed.toGive, currency)}</strong>
                  </span>
                )}
              </span>
              <Icon name="right" size={18} />
            </button>
          )}

          <MonthSwitcher month={month} onChange={setMonth} />

          <section className="card" aria-label="This month">
            <div className="tiles tiles-flush">
              <div className="tile">
                <span className="tile-label">
                  <span className="dot dot-income" aria-hidden="true" /> Added
                </span>
                <span className="tile-value">{formatMoney(totals.income, currency)}</span>
              </div>
              <div className="tile">
                <span className="tile-label">
                  <span className="dot dot-expense" aria-hidden="true" /> Spent
                </span>
                <span className="tile-value">{formatMoney(totals.expense, currency)}</span>
              </div>
              <div className="tile">
                <span className="tile-label">Left over</span>
                <span className="tile-value">{formatMoney(totals.net, currency, { sign: totals.net !== 0 })}</span>
              </div>
            </div>
          </section>

          {monthlyBudget ? (
            <section className="card">
              <BudgetMeter label="Monthly budget" spent={totals.expense} limit={monthlyBudget} currency={currency} />
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
                <button className="link-btn" onClick={() => openTracker('month')}>
                  Monthly tracker
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
        </>
      )}
    </div>
  );
}
