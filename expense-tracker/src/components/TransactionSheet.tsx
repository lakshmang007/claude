import { useState, type FormEvent } from 'react';
import type { TxType } from '../types';
import { amountToInput, currencySymbol, formatMoney, parseAmount } from '../lib/money';
import { isValidISODate, todayISO, toISODate } from '../lib/dates';
import { useStore } from '../store';
import { useFeedback } from './Feedback';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

interface Props {
  id?: string;
  initialType?: TxType;
  /** A date to start a new entry on, when the person is looking at another month. */
  defaultDate?: string;
  onClose: () => void;
}

export function TransactionSheet({ id, initialType, defaultDate, onClose }: Props) {
  const store = useStore();
  const { notify } = useFeedback();
  const { categories, settings } = store.data;
  const existing = id ? store.data.transactions.find((tx) => tx.id === id) : undefined;

  const [type, setType] = useState<TxType>(existing?.type ?? initialType ?? 'expense');
  const [amountText, setAmountText] = useState(existing ? amountToInput(existing.amount) : '');
  const [categoryId, setCategoryId] = useState<string | null>(existing?.categoryId ?? null);
  const [date, setDate] = useState(existing?.date ?? defaultDate ?? todayISO());
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const today = todayISO();
  const now = new Date();
  const yesterday = toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const choices = categories.filter((c) => c.type === type);

  if (id && !existing) {
    return (
      <Sheet title="Transaction" onClose={onClose}>
        <p className="empty-note">This transaction no longer exists.</p>
      </Sheet>
    );
  }

  const switchType = (next: TxType) => {
    setType(next);
    if (categoryId && categories.find((c) => c.id === categoryId)?.type !== next) setCategoryId(null);
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseAmount(amountText);
    if (amount === null) return setError('Enter an amount greater than zero, like 250 or 99.50.');
    if (!categoryId) return setError('Pick a category.');
    if (!isValidISODate(date)) return setError('Pick a date.');
    const input = { type, amount, categoryId, date, note: note.trim().slice(0, 200) };
    const name = categories.find((c) => c.id === categoryId)?.name ?? '';
    if (existing) {
      store.updateTransaction(existing.id, input);
      notify('Changes saved');
    } else {
      store.addTransaction(input);
      notify(`${type === 'expense' ? 'Spent' : 'Added'} ${formatMoney(amount, settings.currency)} · ${name}`);
    }
    onClose();
  };

  const remove = () => {
    if (!existing) return;
    const removed = store.deleteTransaction(existing.id);
    onClose();
    if (removed) notify('Transaction deleted', { label: 'Undo', run: () => store.restoreTransaction(removed) });
  };

  return (
    <Sheet
      title={existing ? 'Edit transaction' : type === 'expense' ? 'Add expense' : 'Add money'}
      onClose={onClose}
      footer={
        <div className="sheet-actions">
          {existing && (
            <button type="button" className="btn btn-ghost btn-danger-text" onClick={remove}>
              <Icon name="trash" size={18} /> Delete
            </button>
          )}
          <button type="submit" form="tx-form" className="btn btn-primary btn-grow">
            {existing ? 'Save changes' : 'Save'}
          </button>
        </div>
      }
    >
      <form id="tx-form" className="tx-form" onSubmit={submit} noValidate>
        <div className="segmented" role="radiogroup" aria-label="Type">
          {(['expense', 'income'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={type === option}
              className={type === option ? 'active' : ''}
              onClick={() => switchType(option)}
            >
              {option === 'expense' ? 'Expense' : 'Income'}
            </button>
          ))}
        </div>

        <label className="amount-field">
          <span className="visually-hidden">Amount</span>
          <span className="amount-symbol" aria-hidden="true">
            {currencySymbol(settings.currency)}
          </span>
          <input
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={amountText}
            onChange={(event) => {
              setAmountText(event.target.value);
              setError(null);
            }}
            autoFocus={!existing}
            enterKeyHint="next"
            aria-invalid={error?.startsWith('Enter') || undefined}
          />
        </label>

        <fieldset className="field">
          <legend>Category</legend>
          <div className="category-grid">
            {choices.map((category) => (
              <button
                key={category.id}
                type="button"
                className={`category-chip ${categoryId === category.id ? 'active' : ''}`}
                aria-pressed={categoryId === category.id}
                onClick={() => {
                  setCategoryId(category.id);
                  setError(null);
                }}
              >
                <span className="category-emoji" aria-hidden="true">
                  {category.icon}
                </span>
                <span className="category-name">{category.name}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label htmlFor="tx-date">Date</label>
          <div className="date-row">
            <input id="tx-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
            <button type="button" className={`chip ${date === today ? 'active' : ''}`} onClick={() => setDate(today)}>
              Today
            </button>
            <button type="button" className={`chip ${date === yesterday ? 'active' : ''}`} onClick={() => setDate(yesterday)}>
              Yesterday
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="tx-note">Note</label>
          <input
            id="tx-note"
            type="text"
            placeholder="What was it for? (optional)"
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
            enterKeyHint="done"
          />
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
