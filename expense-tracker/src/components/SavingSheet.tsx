import { useState, type FormEvent } from 'react';
import { amountToInput, currencySymbol, formatMoney, parseAmount } from '../lib/money';
import { isValidISODate, todayISO, toISODate } from '../lib/dates';
import { frequentCravings } from '../lib/stats';
import { useStore } from '../store';
import { useFeedback } from './Feedback';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/** Logs a craving the person skipped; its price goes into the savings jar. */
export function SavingSheet({ id, onClose }: { id?: string; onClose: () => void }) {
  const store = useStore();
  const { notify } = useFeedback();
  const { currency } = store.data.settings;
  const existing = id ? store.data.savings.find((s) => s.id === id) : undefined;
  const [item, setItem] = useState(existing?.item ?? '');
  const [amountText, setAmountText] = useState(existing ? amountToInput(existing.amount) : '');
  const [date, setDate] = useState(existing?.date ?? todayISO());
  const [error, setError] = useState<string | null>(null);
  const picks = existing ? [] : frequentCravings(store.data.savings);

  const today = todayISO();
  const now = new Date();
  const yesterday = toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  if (id && !existing) {
    return (
      <Sheet title="Skipped craving" onClose={onClose}>
        <p className="empty-note">This entry no longer exists.</p>
      </Sheet>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = item.trim();
    if (!name) return setError('Say what you skipped, like "Chocolate cake".');
    const amount = parseAmount(amountText);
    if (amount === null) return setError('Enter what it would have cost, like 30 or 49.50.');
    if (!isValidISODate(date)) return setError('Pick a date.');
    const input = { item: name.slice(0, 60), amount, date };
    if (existing) {
      store.updateSaving(existing.id, input);
      notify('Changes saved');
    } else {
      store.addSaving(input);
      notify(`${formatMoney(amount, currency)} saved by skipping ${name}`);
    }
    onClose();
  };

  const remove = () => {
    if (!existing) return;
    const removed = store.deleteSaving(existing.id);
    onClose();
    if (removed) notify('Removed from savings', { label: 'Undo', run: () => store.restoreSaving(removed) });
  };

  return (
    <Sheet
      title={existing ? 'Edit skipped craving' : 'Skip a craving'}
      onClose={onClose}
      footer={
        <div className="sheet-actions">
          {existing && (
            <button type="button" className="btn btn-ghost btn-danger-text" onClick={remove}>
              <Icon name="trash" size={18} /> Delete
            </button>
          )}
          <button type="submit" form="saving-form" className="btn btn-primary btn-grow">
            {existing ? 'Save changes' : 'Add to savings'}
          </button>
        </div>
      }
    >
      <form id="saving-form" className="tx-form" onSubmit={submit} noValidate>
        {!existing && <p className="muted">Wanted something and didn't buy it? Its price counts as money saved.</p>}

        {picks.length > 0 && (
          <div className="field">
            <span>Skipped before</span>
            <div className="pick-row">
              {picks.map((pick) => (
                <button
                  key={pick.item}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setItem(pick.item);
                    setAmountText(amountToInput(pick.amount));
                    setError(null);
                  }}
                >
                  {pick.item} · {formatMoney(pick.amount, currency)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="saving-item">What did you skip?</label>
          <input
            id="saving-item"
            type="text"
            placeholder="Chocolate cake"
            value={item}
            maxLength={60}
            autoFocus={!existing}
            enterKeyHint="next"
            onChange={(event) => {
              setItem(event.target.value);
              setError(null);
            }}
          />
        </div>

        <label className="amount-field">
          <span className="visually-hidden">What it would have cost</span>
          <span className="amount-symbol" aria-hidden="true">
            {currencySymbol(currency)}
          </span>
          <input
            name="saving-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amountText}
            enterKeyHint="done"
            onChange={(event) => {
              setAmountText(event.target.value);
              setError(null);
            }}
          />
        </label>

        <div className="field">
          <label htmlFor="saving-date">Date</label>
          <div className="date-row">
            <input id="saving-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <button type="button" className={`chip ${date === today ? 'active' : ''}`} onClick={() => setDate(today)}>
              Today
            </button>
            <button type="button" className={`chip ${date === yesterday ? 'active' : ''}`} onClick={() => setDate(yesterday)}>
              Yesterday
            </button>
          </div>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
