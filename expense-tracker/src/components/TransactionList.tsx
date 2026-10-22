import type { Transaction } from '../types';
import { dayLabel } from '../lib/dates';
import { formatMoney } from '../lib/money';
import { groupByDay } from '../lib/stats';
import { useCategoryMap, useStore } from '../store';

export function TransactionRow({ tx, onOpen }: { tx: Transaction; onOpen: (tx: Transaction) => void }) {
  const categories = useCategoryMap();
  const { currency } = useStore().data.settings;
  const category = categories.get(tx.categoryId);
  const signed = tx.type === 'income' ? tx.amount : -tx.amount;
  return (
    <li>
      <button className="tx-row" onClick={() => onOpen(tx)}>
        <span className="tx-icon" aria-hidden="true">
          {category?.icon ?? '❔'}
        </span>
        <span className="tx-text">
          <span className="tx-title">{tx.note || category?.name || 'Unknown'}</span>
          {tx.note && <span className="tx-sub">{category?.name ?? 'Unknown'}</span>}
        </span>
        <span className={`tx-amount ${tx.type}`}>{formatMoney(signed, currency, { sign: true })}</span>
      </button>
    </li>
  );
}

/** A newest-first list, with a heading and the day's net for each day. */
export function TransactionList({ transactions, onOpen }: { transactions: Transaction[]; onOpen: (tx: Transaction) => void }) {
  const { currency } = useStore().data.settings;
  return (
    <div className="day-groups">
      {groupByDay(transactions).map((group) => (
        <section key={group.date} className="day-group" aria-label={dayLabel(group.date)}>
          <h3 className="day-heading">
            <span>{dayLabel(group.date)}</span>
            <span className="day-net">{formatMoney(group.net, currency, { sign: true })}</span>
          </h3>
          <ul className="tx-list card">
            {group.items.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
