import { useMemo } from 'react';
import type { ScreenProps } from '../App';
import { Icon } from '../components/Icon';
import { MonthSwitcher } from '../components/MonthSwitcher';
import { ScreenHeader } from '../components/ScreenHeader';
import { TransactionList } from '../components/TransactionList';
import { formatMoney } from '../lib/money';
import { filterTransactions, totalsFor } from '../lib/stats';
import { useStore } from '../store';

export function Transactions({ month, setMonth, openTransaction, filter, setFilter, goTab }: ScreenProps) {
  const { transactions, categories, settings } = useStore().data;
  const list = useMemo(
    () => filterTransactions(transactions, categories, { ...filter, month: filter.allTime ? null : month }),
    [transactions, categories, filter, month],
  );
  const totals = useMemo(() => totalsFor(list), [list]);
  const shownCategories = categories.filter((c) => filter.type === 'all' || c.type === filter.type);
  const filtered = filter.query.trim() !== '' || filter.type !== 'all' || filter.categoryId !== null;

  return (
    <div className="screen-inner">
      <ScreenHeader title="History" onSettings={() => goTab('settings')} />

      <div className="search">
        <Icon name="search" size={18} />
        <input
          type="search"
          placeholder="Search notes, categories, amounts"
          value={filter.query}
          onChange={(event) => setFilter({ ...filter, query: event.target.value })}
          aria-label="Search transactions"
        />
      </div>

      <div className="filter-row">
        {(['all', 'expense', 'income'] as const).map((type) => (
          <button
            key={type}
            className={`chip ${filter.type === type ? 'active' : ''}`}
            aria-pressed={filter.type === type}
            onClick={() => {
              const keep = filter.categoryId && categories.find((c) => c.id === filter.categoryId)?.type === type;
              setFilter({ ...filter, type, categoryId: type === 'all' || keep ? filter.categoryId : null });
            }}
          >
            {type === 'all' ? 'All' : type === 'expense' ? 'Expenses' : 'Income'}
          </button>
        ))}
        <select
          className="chip chip-select"
          value={filter.categoryId ?? ''}
          onChange={(event) => setFilter({ ...filter, categoryId: event.target.value || null })}
          aria-label="Category"
        >
          <option value="">Any category</option>
          {shownCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon} {c.name}
              {filter.type === 'all' ? ` (${c.type === 'expense' ? 'expense' : 'income'})` : ''}
            </option>
          ))}
        </select>
        <button
          className={`chip ${filter.allTime ? 'active' : ''}`}
          aria-pressed={filter.allTime}
          onClick={() => setFilter({ ...filter, allTime: !filter.allTime })}
        >
          All time
        </button>
      </div>

      {!filter.allTime && <MonthSwitcher month={month} onChange={setMonth} />}

      <p className="list-summary">
        {list.length} transaction{list.length === 1 ? '' : 's'}
        {list.length > 0 && (
          <>
            {' · '}spent {formatMoney(totals.expense, settings.currency)}
            {totals.income > 0 && <> · earned {formatMoney(totals.income, settings.currency)}</>}
          </>
        )}
        {filtered && (
          <button className="link-btn" onClick={() => setFilter({ ...filter, query: '', type: 'all', categoryId: null })}>
            Clear filters
          </button>
        )}
      </p>

      {list.length ? (
        <TransactionList transactions={list} onOpen={(tx) => openTransaction(tx.id)} />
      ) : (
        <p className="empty-note card">
          {filtered ? 'Nothing matches these filters.' : filter.allTime ? 'No transactions yet.' : 'Nothing recorded this month.'}
        </p>
      )}
    </div>
  );
}
