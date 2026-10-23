import { useMemo } from 'react';
import type { ScreenProps } from '../App';
import { useFeedback } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { currentMonth, dayLabel, monthOf, todayISO } from '../lib/dates';
import { formatMoney } from '../lib/money';
import { frequentCravings, sortSavings } from '../lib/stats';
import { useStore } from '../store';

export function Savings({ openSaving }: ScreenProps) {
  const store = useStore();
  const { notify } = useFeedback();
  const { savings, settings } = store.data;
  const { currency } = settings;
  const list = useMemo(() => sortSavings(savings), [savings]);
  const picks = useMemo(() => frequentCravings(savings), [savings]);
  const thisMonth = useMemo(() => {
    const month = currentMonth();
    return savings.filter((s) => monthOf(s.date) === month).reduce((sum, s) => sum + s.amount, 0);
  }, [savings]);

  // One tap logs a craving skipped before, at its last price.
  const skipAgain = (item: string, amount: number) => {
    const saving = store.addSaving({ item, amount, date: todayISO() });
    notify(`${formatMoney(amount, currency)} saved by skipping ${item}`, { label: 'Undo', run: () => store.deleteSaving(saving.id) });
  };

  return (
    <div className="screen-inner">
      <header className="screen-header">
        <h1>Savings</h1>
      </header>

      <section className="card jar" aria-label="Savings jar">
        <span className="balance-label">Saved by skipping cravings</span>
        <span className="hero-figure">{formatMoney(store.balances.saved, currency)}</span>
        <div className="tiles tiles-flush">
          <div className="tile">
            <span className="tile-label">This month</span>
            <span className="tile-value">{formatMoney(thisMonth, currency)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">Cravings skipped</span>
            <span className="tile-value">{savings.length}</span>
          </div>
        </div>
        <button className="btn btn-primary btn-block" onClick={() => openSaving()}>
          <Icon name="plus" size={20} /> Skip a craving
        </button>
      </section>

      {picks.length > 0 && (
        <section className="card">
          <h2>Skip again</h2>
          <p className="muted spaced-below">Tap one to save its price again today.</p>
          <div className="pick-row">
            {picks.map((pick) => (
              <button key={pick.item} className="chip" onClick={() => skipAgain(pick.item, pick.amount)}>
                {pick.item} · {formatMoney(pick.amount, currency)}
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Skipped</h2>
        </div>
        {list.length ? (
          <ul className="tx-list card">
            {list.map((saving) => (
              <li key={saving.id}>
                <button className="tx-row" onClick={() => openSaving(saving.id)}>
                  <span className="tx-icon" aria-hidden="true">
                    <Icon name="jar" size={20} />
                  </span>
                  <span className="tx-text">
                    <span className="tx-title">{saving.item}</span>
                    <span className="tx-sub">{dayLabel(saving.date)}</span>
                  </span>
                  <span className="tx-amount income">{formatMoney(saving.amount, currency, { sign: true })}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty-note card">
            <p>Nothing saved yet.</p>
            <p className="muted">
              Next time you want a {formatMoney(3000, currency)} chocolate cake and don't buy it, add it here. That{' '}
              {formatMoney(3000, currency)} counts as saved.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
