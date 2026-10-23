import type { Category, Debt, Saving, Transaction, TxType } from '../types';
import { currentMonth, daysInMonth, monthOf, parseISODate, shiftMonth, todayISO, toISODate } from './dates';
import { debtCashEvents } from './people';
import { SCALE } from './money';

export interface Totals {
  income: number;
  expense: number;
  net: number;
  count: number;
}

export function totalsFor(transactions: Transaction[]): Totals {
  let income = 0;
  let expense = 0;
  for (const tx of transactions) {
    if (tx.type === 'income') income += tx.amount;
    else expense += tx.amount;
  }
  return { income, expense, net: income - expense, count: transactions.length };
}

export function inMonth(transactions: Transaction[], month: string): Transaction[] {
  return transactions.filter((tx) => monthOf(tx.date) === month);
}

export interface CategoryShare {
  category: Category;
  total: number;
  count: number;
  /** 0–1 of the type's total. */
  share: number;
}

/** Totals per category for one type, largest first. */
export function byCategory(transactions: Transaction[], categories: Category[], type: TxType): CategoryShare[] {
  const sums = new Map<string, { total: number; count: number }>();
  let all = 0;
  for (const tx of transactions) {
    if (tx.type !== type) continue;
    const entry = sums.get(tx.categoryId) ?? { total: 0, count: 0 };
    entry.total += tx.amount;
    entry.count += 1;
    sums.set(tx.categoryId, entry);
    all += tx.amount;
  }
  const byId = new Map(categories.map((c) => [c.id, c]));
  return [...sums.entries()]
    .map(([id, { total, count }]) => ({
      category: byId.get(id) ?? { id, name: 'Unknown', icon: '❔', type },
      total,
      count,
      share: all > 0 ? total / all : 0,
    }))
    .sort((a, b) => b.total - a.total || a.category.name.localeCompare(b.category.name));
}

export interface MonthPoint extends Totals {
  month: string;
}

/** The `count` months ending with `lastMonth`, oldest first. */
export function monthlySeries(transactions: Transaction[], lastMonth: string, count: number): MonthPoint[] {
  const months = Array.from({ length: count }, (_, i) => shiftMonth(lastMonth, i - count + 1));
  const grouped = new Map<string, Transaction[]>(months.map((m) => [m, []]));
  for (const tx of transactions) grouped.get(monthOf(tx.date))?.push(tx);
  return months.map((month) => ({ month, ...totalsFor(grouped.get(month) ?? []) }));
}

/** Whole units spent per day: per day elapsed in the current month, per day of the month otherwise. */
export function dailyAverage(expense: number, month: string, now = new Date()): number {
  const thisMonth = currentMonth(now);
  if (month > thisMonth) return 0;
  const days = month === thisMonth ? Number(todayISO(now).slice(8, 10)) : daysInMonth(month);
  return Math.round(expense / days / SCALE) * SCALE;
}

export interface Filter {
  /** YYYY-MM, or null for all time. */
  month: string | null;
  type: TxType | 'all';
  categoryId: string | null;
  query: string;
}

/** Newest first. The query matches the note, the category name or the amount. */
export function filterTransactions(transactions: Transaction[], categories: Category[], filter: Filter): Transaction[] {
  const names = new Map(categories.map((c) => [c.id, c.name.toLowerCase()]));
  const query = filter.query.trim().toLowerCase();
  return transactions
    .filter((tx) => {
      if (filter.month && monthOf(tx.date) !== filter.month) return false;
      if (filter.type !== 'all' && tx.type !== filter.type) return false;
      if (filter.categoryId && tx.categoryId !== filter.categoryId) return false;
      if (!query) return true;
      const amount = (tx.amount / 100).toString();
      return tx.note.toLowerCase().includes(query) || (names.get(tx.categoryId) ?? '').includes(query) || amount.startsWith(query);
    })
    .sort(newestFirst);
}

export function newestFirst(a: Transaction, b: Transaction): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt;
}

interface CashEvent {
  id: string;
  date: string;
  createdAt: number;
  /** What it added to (positive) or took off (negative) "money you have". */
  delta: number;
}

/** Everything that moved "money you have": entries, and money lent or borrowed and paid back. */
function cashEvents(transactions: Transaction[], debts: Debt[]): CashEvent[] {
  return [
    ...transactions.map((tx) => ({ id: tx.id, date: tx.date, createdAt: tx.createdAt, delta: tx.type === 'income' ? tx.amount : -tx.amount })),
    ...debts.flatMap(debtCashEvents),
  ];
}

/** Money on hand today: the opening balance plus everything dated today or earlier. */
export function balanceNow(
  transactions: Transaction[],
  openingBalance: number,
  { debts = [], now = new Date() }: { debts?: Debt[]; now?: Date } = {},
): number {
  const today = todayISO(now);
  return cashEvents(transactions, debts).reduce((sum, event) => (event.date <= today ? sum + event.delta : sum), openingBalance);
}

/**
 * The money left after each entry (and each debt or payment that moved money), by id, taking
 * them in date order, then the order they were added.
 */
export function runningBalances(transactions: Transaction[], openingBalance: number, debts: Debt[] = []): Map<string, number> {
  const after = new Map<string, number>();
  let balance = openingBalance;
  const events = cashEvents(transactions, debts).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
  for (const event of events) {
    balance += event.delta;
    after.set(event.id, balance);
  }
  return after;
}

/** Totals for each day of a month that has entries, by YYYY-MM-DD. */
export function dailyTotals(transactions: Transaction[], month: string): Map<string, Totals> {
  const days = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (monthOf(tx.date) !== month) continue;
    days.set(tx.date, [...(days.get(tx.date) ?? []), tx]);
  }
  return new Map([...days].map(([date, list]) => [date, totalsFor(list)]));
}

export interface DayPoint extends Totals {
  date: string;
}

/** The `count` days ending with `lastDay`, oldest first. */
export function dailySeries(transactions: Transaction[], lastDay: string, count: number): DayPoint[] {
  const end = parseISODate(lastDay);
  const days = Array.from({ length: count }, (_, i) => toISODate(new Date(end.getFullYear(), end.getMonth(), end.getDate() - count + 1 + i)));
  const grouped = new Map<string, Transaction[]>(days.map((d) => [d, []]));
  for (const tx of transactions) grouped.get(tx.date)?.push(tx);
  return days.map((date) => ({ date, ...totalsFor(grouped.get(date) ?? []) }));
}

export interface DayGroup {
  date: string;
  items: Transaction[];
  net: number;
}

/** Groups an already sorted list by day. */
export function groupByDay(transactions: Transaction[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const tx of transactions) {
    let group = groups[groups.length - 1];
    if (!group || group.date !== tx.date) {
      group = { date: tx.date, items: [], net: 0 };
      groups.push(group);
    }
    group.items.push(tx);
    group.net += tx.type === 'income' ? tx.amount : -tx.amount;
  }
  return groups;
}

export type BudgetLevel = 'ok' | 'near' | 'over';

/** "near" from 80% of the limit; "over" once spending passes it. */
export function budgetLevel(spent: number, limit: number): BudgetLevel {
  if (spent > limit) return 'over';
  return spent >= limit * 0.8 ? 'near' : 'ok';
}

export interface CravingPick {
  item: string;
  /** What it cost the last time it was skipped. */
  amount: number;
  count: number;
}

/** Cravings skipped before, most often first, so they can be logged again with one tap. */
export function frequentCravings(savings: Saving[], limit = 6): CravingPick[] {
  const picks = new Map<string, CravingPick & { last: number }>();
  for (const saving of [...savings].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = saving.item.trim().toLowerCase();
    const pick = picks.get(key);
    picks.set(key, { item: saving.item, amount: saving.amount, count: (pick?.count ?? 0) + 1, last: saving.createdAt });
  }
  return [...picks.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, limit)
    .map(({ item, amount, count }) => ({ item, amount, count }));
}

/** Newest first, like transactions. */
export function sortSavings(savings: Saving[]): Saving[] {
  return [...savings].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}
