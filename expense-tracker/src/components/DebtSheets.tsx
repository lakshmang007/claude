import { useState, type FormEvent } from 'react';
import type { Debt, DebtKind } from '../types';
import { dayLabel, isValidISODate, todayISO, toISODate } from '../lib/dates';
import { amountToInput, currencySymbol, formatMoney, parseAmount } from '../lib/money';
import { isSettled, peopleSummary, personKey, remaining } from '../lib/people';
import { useStore } from '../store';
import { useFeedback } from './Feedback';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

function DateField({ id, date, onChange }: { id: string; date: string; onChange: (date: string) => void }) {
  const today = todayISO();
  const now = new Date();
  const yesterday = toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return (
    <div className="field">
      <label htmlFor={id}>Date</label>
      <div className="date-row">
        <input id={id} type="date" value={date} onChange={(event) => onChange(event.target.value)} />
        <button type="button" className={`chip ${date === today ? 'active' : ''}`} onClick={() => onChange(today)}>
          Today
        </button>
        <button type="button" className={`chip ${date === yesterday ? 'active' : ''}`} onClick={() => onChange(yesterday)}>
          Yesterday
        </button>
      </div>
    </div>
  );
}

function AmountField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (text: string) => void; autoFocus?: boolean }) {
  const { currency } = useStore().data.settings;
  return (
    <label className="amount-field">
      <span className="visually-hidden">{label}</span>
      <span className="amount-symbol" aria-hidden="true">
        {currencySymbol(currency)}
      </span>
      <input inputMode="decimal" autoComplete="off" placeholder="0" value={value} autoFocus={autoFocus} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

/** Notes money someone owes you (lent) or you owe them (borrowed), or edits such a note. */
export function DebtSheet({
  id,
  debtKind,
  person: presetPerson,
  onClose,
}: {
  id?: string;
  debtKind?: DebtKind;
  person?: string;
  onClose: () => void;
}) {
  const store = useStore();
  const { notify } = useFeedback();
  const { currency } = store.data.settings;
  const existing = id ? store.data.debts.find((d) => d.id === id) : undefined;
  const [kind, setKind] = useState<DebtKind>(existing?.kind ?? debtKind ?? 'lent');
  const [person, setPerson] = useState(existing?.person ?? presetPerson ?? '');
  const [amountText, setAmountText] = useState(existing ? amountToInput(existing.amount) : '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [date, setDate] = useState(existing?.date ?? todayISO());
  const [cash, setCash] = useState(existing?.cash ?? true);
  const [error, setError] = useState<string | null>(null);
  const known = peopleSummary(store.data.debts).slice(0, 8).map((p) => p.name);

  if (id && !existing) {
    return (
      <Sheet title="Money owed" onClose={onClose}>
        <p className="empty-note">This entry no longer exists.</p>
      </Sheet>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = person.trim().replace(/\s+/g, ' ');
    if (!name) return setError('Write who it is, like "Rahul".');
    const amount = parseAmount(amountText);
    if (amount === null) return setError('Enter the amount, like 500.');
    if (existing && amount < existing.amount - remaining(existing)) {
      return setError(`${formatMoney(existing.amount - remaining(existing), currency)} has already been paid back, so the amount can't be less.`);
    }
    if (!isValidISODate(date)) return setError('Pick a date.');
    const input = { person: name.slice(0, 40), kind, amount, note: note.trim().slice(0, 200), date, cash };
    if (existing) {
      store.updateDebt(existing.id, input);
      notify('Changes saved');
    } else {
      store.addDebt(input);
      notify(kind === 'lent' ? `Noted: ${name} has to give you ${formatMoney(amount, currency)}` : `Noted: you have to give ${name} ${formatMoney(amount, currency)}`);
    }
    onClose();
  };

  const remove = () => {
    if (!existing) return;
    const removed = store.deleteDebt(existing.id);
    onClose();
    if (removed) notify('Entry deleted', { label: 'Undo', run: () => store.restoreDebt(removed) });
  };

  return (
    <Sheet
      title={existing ? 'Edit entry' : kind === 'lent' ? 'Money to get back' : 'Money to give'}
      onClose={onClose}
      footer={
        <div className="sheet-actions">
          {existing && (
            <button type="button" className="btn btn-ghost btn-danger-text" onClick={remove}>
              <Icon name="trash" size={18} /> Delete
            </button>
          )}
          <button type="submit" form="debt-form" className="btn btn-primary btn-grow">
            Save
          </button>
        </div>
      }
    >
      <form id="debt-form" className="tx-form" onSubmit={submit} noValidate>
        <div className="segmented" role="radiogroup" aria-label="Who has to pay">
          {(['lent', 'borrowed'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={kind === option}
              className={kind === option ? 'active' : ''}
              onClick={() => setKind(option)}
            >
              {option === 'lent' ? 'They owe me' : 'I owe them'}
            </button>
          ))}
        </div>

        <div className="field">
          <label htmlFor="debt-person">{kind === 'lent' ? 'Who has to give you money?' : 'Who do you have to give money to?'}</label>
          <input
            id="debt-person"
            type="text"
            placeholder="Friend's name"
            value={person}
            maxLength={40}
            autoFocus={!existing && !presetPerson}
            onChange={(event) => {
              setPerson(event.target.value);
              setError(null);
            }}
          />
          {!existing && known.length > 0 && (
            <div className="pick-row">
              {known.map((name) => (
                <button key={name} type="button" className={`chip ${personKey(name) === personKey(person) ? 'active' : ''}`} onClick={() => setPerson(name)}>
                  {name}
                </button>
              ))}
            </div>
          )}
        </div>

        <AmountField
          label="How much"
          value={amountText}
          autoFocus={!existing && !!presetPerson}
          onChange={(text) => {
            setAmountText(text);
            setError(null);
          }}
        />

        <div className="field">
          <label htmlFor="debt-note">What for?</label>
          <input id="debt-note" type="text" placeholder="Optional, like movie tickets" value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
        </div>

        <DateField id="debt-date" date={date} onChange={setDate} />

        <label className="check-field">
          <input type="checkbox" checked={cash} onChange={(event) => setCash(event.target.checked)} />
          <span>
            {kind === 'lent' ? 'I gave this money from my own money' : 'I got this money in hand'}
            <small>{kind === 'lent' ? 'Takes it off Money you have.' : 'Adds it to Money you have.'} Leave unticked if no money changed hands, like when a friend paid your share.</small>
          </span>
        </label>

        {existing && existing.payments.length > 0 && (
          <div className="field">
            <span>Paid back so far</span>
            <ul className="payment-list">
              {existing.payments.map((payment) => (
                <li key={payment.id}>
                  <span>
                    {formatMoney(payment.amount, currency)} · {dayLabel(payment.date)}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove the ${formatMoney(payment.amount, currency)} payment`}
                    onClick={() => {
                      store.deletePayment(existing.id, payment.id);
                      notify('Payment removed', {
                        label: 'Undo',
                        run: () => store.addPayment(existing.id, { amount: payment.amount, date: payment.date, cash: payment.cash }),
                      });
                    }}
                  >
                    <Icon name="close" size={18} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}

/** Everything noted with one person, with what is left to settle. */
export function PersonSheet({
  personKey: key,
  onClose,
  onPay,
  onEdit,
  onAdd,
}: {
  personKey: string;
  onClose: () => void;
  onPay: (debt: Debt) => void;
  onEdit: (debt: Debt) => void;
  onAdd: (person: string, kind: DebtKind) => void;
}) {
  const store = useStore();
  const { currency } = store.data.settings;
  const person = peopleSummary(store.data.debts).find((p) => p.key === key);

  if (!person) {
    return (
      <Sheet title="Person" onClose={onClose}>
        <p className="empty-note">Nothing is noted with this person any more.</p>
      </Sheet>
    );
  }

  const sorted = [...person.debts].sort(
    (a, b) => Number(isSettled(a)) - Number(isSettled(b)) || (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt),
  );

  return (
    <Sheet
      title={person.name}
      onClose={onClose}
      footer={
        <div className="sheet-actions">
          <button type="button" className="btn btn-money-in btn-grow" onClick={() => onAdd(person.name, 'lent')}>
            <Icon name="plus" size={18} /> They owe me
          </button>
          <button type="button" className="btn btn-money-out btn-grow" onClick={() => onAdd(person.name, 'borrowed')}>
            <Icon name="plus" size={18} /> I owe them
          </button>
        </div>
      }
    >
      <div className="person-summary">
        {person.net > 0 && (
          <p>
            <strong className="owed-to-you">{formatMoney(person.net, currency)}</strong> to get back from {person.name}
          </p>
        )}
        {person.net < 0 && (
          <p>
            <strong className="you-owe">{formatMoney(-person.net, currency)}</strong> to give to {person.name}
          </p>
        )}
        {person.net === 0 && <p>{person.open ? 'What you owe each other evens out.' : 'All settled.'}</p>}
        {person.toGet > 0 && person.toGive > 0 && (
          <p className="muted">
            {formatMoney(person.toGet, currency)} to get back and {formatMoney(person.toGive, currency)} to give
          </p>
        )}
      </div>

      <ul className="debt-list">
        {sorted.map((debt) => {
          const left = remaining(debt);
          const paid = debt.amount - left;
          return (
            <li key={debt.id} className={`debt ${left === 0 ? 'settled' : ''}`}>
              <button type="button" className="debt-main" onClick={() => onEdit(debt)}>
                <span className="debt-title">{debt.note || (debt.kind === 'lent' ? 'They owe me' : 'I owe them')}</span>
                <span className="debt-sub">
                  {dayLabel(debt.date)} · {debt.kind === 'lent' ? 'They owe' : 'You owe'} {formatMoney(debt.amount, currency)}
                  {paid > 0 && left > 0 && ` · ${formatMoney(paid, currency)} paid back`}
                </span>
              </button>
              <div className="debt-side">
                {left > 0 ? (
                  <>
                    <span className={debt.kind === 'lent' ? 'owed-to-you' : 'you-owe'}>{formatMoney(left, currency)} left</span>
                    <button type="button" className="btn btn-outline btn-small" onClick={() => onPay(debt)}>
                      {debt.kind === 'lent' ? 'Got money back' : 'Paid back'}
                    </button>
                  </>
                ) : (
                  <span className="settled-tag">
                    <Icon name="check" size={16} /> Settled
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** Records money paid back on a debt, in full by default. */
export function PaymentSheet({ debtId, onClose }: { debtId: string; onClose: () => void }) {
  const store = useStore();
  const { notify } = useFeedback();
  const { currency } = store.data.settings;
  const debt = store.data.debts.find((d) => d.id === debtId);
  const left = debt ? remaining(debt) : 0;
  const [amountText, setAmountText] = useState(left > 0 ? amountToInput(left) : '');
  const [date, setDate] = useState(todayISO());
  const [cash, setCash] = useState(true);
  const [error, setError] = useState<string | null>(null);

  if (!debt) {
    return (
      <Sheet title="Paid back" onClose={onClose}>
        <p className="empty-note">This entry no longer exists.</p>
      </Sheet>
    );
  }

  const lent = debt.kind === 'lent';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseAmount(amountText);
    if (amount === null) return setError('Enter the amount paid back.');
    if (amount > left) return setError(`Only ${formatMoney(left, currency)} is left on this.`);
    if (!isValidISODate(date)) return setError('Pick a date.');
    const payment = store.addPayment(debt.id, { amount, date, cash });
    const rest = left - amount;
    const message = lent
      ? rest
        ? `Got ${formatMoney(amount, currency)} back from ${debt.person}. ${formatMoney(rest, currency)} still to get back.`
        : `${debt.person} has paid you back in full.`
      : rest
        ? `Paid ${formatMoney(amount, currency)} to ${debt.person}. ${formatMoney(rest, currency)} still to give.`
        : `You've paid ${debt.person} back in full.`;
    onClose();
    notify(message, { label: 'Undo', run: () => store.deletePayment(debt.id, payment.id) });
  };

  return (
    <Sheet
      title={lent ? `Money back from ${debt.person}` : `Paying back ${debt.person}`}
      onClose={onClose}
      footer={
        <button type="submit" form="payment-form" className="btn btn-primary btn-block">
          Save
        </button>
      }
    >
      <form id="payment-form" className="tx-form" onSubmit={submit} noValidate>
        <p className="muted">
          {formatMoney(left, currency)} left of {formatMoney(debt.amount, currency)}
          {debt.note ? ` for ${debt.note}` : ''}. Change the amount if only part was paid back.
        </p>
        <AmountField
          label="Amount paid back"
          value={amountText}
          onChange={(text) => {
            setAmountText(text);
            setError(null);
          }}
        />
        <DateField id="payment-date" date={date} onChange={setDate} />
        <label className="check-field">
          <input type="checkbox" checked={cash} onChange={(event) => setCash(event.target.checked)} />
          <span>
            {lent ? 'Add it to Money you have' : 'Take it off Money you have'}
            <small>Leave unticked if it was settled some other way.</small>
          </span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
