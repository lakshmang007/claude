import { useState, type FormEvent } from 'react';
import { amountToInput, currencySymbol, formatMoney, parseAmount } from '../lib/money';
import { useStore } from '../store';
import { useFeedback } from './Feedback';
import { Sheet } from './Sheet';

/** Sets how much money the person has right now, e.g. at the start or after counting their cash. */
export function BalanceSheet({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { notify } = useFeedback();
  const { currency } = store.data.settings;
  const current = store.balances.now;
  const [text, setText] = useState(current > 0 ? amountToInput(current) : '');
  const [error, setError] = useState<string | null>(null);
  const hasEntries = store.data.transactions.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const amount = parseAmount(text, { allowZero: true });
    if (amount === null) return setError('Enter the amount you have, like 5000 or 1250.50. Use 0 if you have nothing.');
    store.setBalanceNow(amount);
    onClose();
    notify(`Money you have: ${formatMoney(amount, currency)}`);
  };

  return (
    <Sheet
      title="Money you have"
      onClose={onClose}
      footer={
        <button type="submit" form="balance-form" className="btn btn-primary btn-block">
          Save
        </button>
      }
    >
      <form id="balance-form" className="tx-form" onSubmit={submit} noValidate>
        <p className="muted">
          How much money do you have right now, in cash and in your account?
          {hasEntries && ' Your entries stay as they are; only the starting amount changes so the total matches.'}
        </p>
        <label className="amount-field">
          <span className="visually-hidden">Amount you have</span>
          <span className="amount-symbol" aria-hidden="true">
            {currencySymbol(currency)}
          </span>
          <input
            name="balance"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={text}
            autoFocus
            enterKeyHint="done"
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
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
