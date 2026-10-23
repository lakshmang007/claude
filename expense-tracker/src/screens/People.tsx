import { useMemo } from 'react';
import type { ScreenProps } from '../App';
import { Icon } from '../components/Icon';
import { ScreenHeader } from '../components/ScreenHeader';
import { formatMoney } from '../lib/money';
import { debtTotals, peopleSummary, type PersonSummary } from '../lib/people';
import { useStore } from '../store';

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 2)).toUpperCase();
}

function PersonRow({ person, currency, onOpen }: { person: PersonSummary; currency: string; onOpen: () => void }) {
  return (
    <li>
      <button className="tx-row" onClick={onOpen}>
        <span className="tx-icon avatar" aria-hidden="true">
          {initials(person.name)}
        </span>
        <span className="tx-text">
          <span className="tx-title">{person.name}</span>
          <span className="tx-sub">
            {person.open === 0 ? 'Settled' : `${person.open} not settled`}
          </span>
        </span>
        <span className="tx-figures">
          {person.net !== 0 && (
            <span className={`tx-amount ${person.net > 0 ? 'owed-to-you' : 'you-owe'}`}>{formatMoney(Math.abs(person.net), currency)}</span>
          )}
          <span className="tx-left">{person.net > 0 ? 'to get back' : person.net < 0 ? 'to give' : person.open ? 'evens out' : 'all clear'}</span>
        </span>
      </button>
    </li>
  );
}

export function People({ goTab, openDebt, openPerson }: ScreenProps) {
  const { debts, settings } = useStore().data;
  const { currency } = settings;
  const people = useMemo(() => peopleSummary(debts), [debts]);
  const totals = useMemo(() => debtTotals(debts), [debts]);
  const open = people.filter((p) => p.open > 0);
  const settled = people.filter((p) => p.open === 0);

  return (
    <div className="screen-inner">
      <ScreenHeader title="People" onSettings={() => goTab('settings')} />

      <section className="card" aria-label="Money owed">
        <div className="tiles tiles-flush tiles-two">
          <div className="tile">
            <span className="tile-label">To get back</span>
            <span className="tile-value owed-to-you">{formatMoney(totals.toGet, currency)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">To give</span>
            <span className="tile-value you-owe">{formatMoney(totals.toGive, currency)}</span>
          </div>
        </div>
        <div className="wallet-actions">
          <button className="btn btn-money-in" onClick={() => openDebt({ debtKind: 'lent' })}>
            <Icon name="plus" size={20} /> They owe me
          </button>
          <button className="btn btn-money-out" onClick={() => openDebt({ debtKind: 'borrowed' })}>
            <Icon name="plus" size={20} /> I owe them
          </button>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Not settled yet</h2>
        </div>
        {open.length ? (
          <ul className="tx-list card">
            {open.map((person) => (
              <PersonRow key={person.key} person={person} currency={currency} onOpen={() => openPerson(person.key)} />
            ))}
          </ul>
        ) : (
          <div className="empty-note card">
            <p>Nothing to settle.</p>
            <p className="muted">
              Lent a friend money, or have to pay someone back? Note it here with <strong>They owe me</strong> or{' '}
              <strong>I owe them</strong> so neither of you forgets.
            </p>
          </div>
        )}
      </section>

      {settled.length > 0 && (
        <details className="card disclosure-card">
          <summary>Settled ({settled.length})</summary>
          <ul className="tx-list">
            {settled.map((person) => (
              <PersonRow key={person.key} person={person} currency={currency} onOpen={() => openPerson(person.key)} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
