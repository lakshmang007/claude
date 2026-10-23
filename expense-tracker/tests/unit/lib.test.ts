import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../src/types';
import { niceScale } from '../../src/components/Charts';
import { toCSV } from '../../src/lib/csv';
import {
  balanceNow,
  budgetLevel,
  byCategory,
  dailyAverage,
  filterTransactions,
  frequentCravings,
  groupByDay,
  monthlySeries,
  newestFirst,
  runningBalances,
  totalsFor,
} from '../../src/lib/stats';
import { dayLabel, daysInMonth, isValidISODate, shiftMonth } from '../../src/lib/dates';
import { createInitialData, DEFAULT_CATEGORIES, OTHER_EXPENSE } from '../../src/lib/defaults';
import { amountToInput, formatMoney, guessCurrency, parseAmount } from '../../src/lib/money';
import { sampleOpeningBalance, sampleSavings, sampleTransactions } from '../../src/lib/sample';
import { loadData, parseBackup, sanitize, saveData, serializeBackup, STORAGE_KEY } from '../../src/lib/storage';

const tx = (over: Partial<Transaction>): Transaction => ({
  id: Math.random().toString(36).slice(2),
  type: 'expense',
  amount: 1000,
  categoryId: 'exp-food',
  date: '2026-10-05',
  note: '',
  createdAt: 0,
  ...over,
});

class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  quota = Infinity;
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    if (value.length > this.quota) throw new DOMException('full', 'QuotaExceededError');
    this.items.set(key, value);
  }
}

describe('parseAmount', () => {
  it.each([
    ['250', 25000],
    ['99.5', 9950],
    ['99.50', 9950],
    ['0.29', 29],
    ['1,250.75', 125075],
    ['1,23,456', 12345600],
    ['12,50', 1250],
    [' 7 ', 700],
    ['.5', 50],
    ['10.', 1000],
  ])('reads %j as %d hundredths', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(['', '0', '0.00', '-5', 'abc', '1.234', '1e5', '.', '1234567890123'])('rejects %j', (input) => {
    expect(parseAmount(input)).toBeNull();
  });

  it('accepts zero only when asked', () => {
    expect(parseAmount('0', { allowZero: true })).toBe(0);
    expect(parseAmount('0.00', { allowZero: true })).toBe(0);
    expect(parseAmount('', { allowZero: true })).toBeNull();
    expect(parseAmount('-1', { allowZero: true })).toBeNull();
  });

  it('round-trips through the edit field', () => {
    for (const amount of [1, 29, 100, 9950, 125075]) expect(parseAmount(amountToInput(amount))).toBe(amount);
  });
});

describe('formatMoney', () => {
  it('drops .00 on whole amounts and keeps cents otherwise', () => {
    expect(formatMoney(125000, 'USD')).toBe(new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(1250));
    expect(formatMoney(125050, 'USD')).toContain('.50');
  });

  it('shortens with K, M and B for chart axes', () => {
    expect(formatMoney(30_000_00, 'INR', { compact: true })).toBe('₹30K');
    expect(formatMoney(1_250_000_00, 'USD', { compact: true })).toBe('$1.3M');
    expect(formatMoney(2_500_00, 'EUR', { compact: true })).toMatch(/^(€2\.5K|2\.5K\s?€)$/);
    expect(formatMoney(999_00, 'INR', { compact: true })).toBe('₹999');
    expect(formatMoney(0, 'INR', { compact: true })).toBe('₹0');
  });

  it('uses a real minus sign and an explicit plus when asked', () => {
    expect(formatMoney(-500, 'INR', { sign: true }).startsWith('−')).toBe(true);
    expect(formatMoney(500, 'INR', { sign: true }).startsWith('+')).toBe(true);
  });
});

describe('guessCurrency', () => {
  it('prefers the time zone, then the locale region', () => {
    expect(guessCurrency('Asia/Kolkata', 'en-US')).toBe('INR');
    expect(guessCurrency('Etc/UTC', 'en-GB')).toBe('GBP');
    expect(guessCurrency('Etc/UTC', 'de-DE')).toBe('EUR');
    expect(guessCurrency('Etc/UTC', 'xx')).toBe('USD');
  });
});

describe('dates', () => {
  it('shifts months across year ends', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-03', -14)).toBe('2025-01');
  });

  it('validates calendar dates', () => {
    expect(isValidISODate('2024-02-29')).toBe(true);
    expect(isValidISODate('2026-02-29')).toBe(false);
    expect(isValidISODate('2026-13-01')).toBe(false);
    expect(isValidISODate('26-01-01')).toBe(false);
  });

  it('knows month lengths and names recent days', () => {
    expect(daysInMonth('2024-02')).toBe(29);
    expect(daysInMonth('2026-04')).toBe(30);
    const now = new Date(2026, 9, 22, 15);
    expect(dayLabel('2026-10-22', now)).toBe('Today');
    expect(dayLabel('2026-10-21', now)).toBe('Yesterday');
  });
});

describe('stats', () => {
  const list = [
    tx({ amount: 3000, categoryId: 'exp-food', date: '2026-10-01' }),
    tx({ amount: 1000, categoryId: 'exp-transport', date: '2026-10-03', note: 'Metro' }),
    tx({ amount: 2000, categoryId: 'exp-food', date: '2026-10-03', createdAt: 5 }),
    tx({ type: 'income', amount: 50000, categoryId: 'inc-salary', date: '2026-10-01' }),
    tx({ amount: 700, categoryId: 'exp-food', date: '2026-09-30' }),
  ];

  it('totals income and spending', () => {
    expect(totalsFor(list)).toEqual({ income: 50000, expense: 6700, net: 43300, count: 5 });
  });

  it('ranks categories by total with their share', () => {
    const rows = byCategory(list.slice(0, 4), DEFAULT_CATEGORIES, 'expense');
    expect(rows.map((r) => [r.category.id, r.total])).toEqual([
      ['exp-food', 5000],
      ['exp-transport', 1000],
    ]);
    expect(rows[0].share).toBeCloseTo(5 / 6);
  });

  it('builds a month series with empty months included', () => {
    const series = monthlySeries(list, '2026-10', 3);
    expect(series.map((p) => [p.month, p.expense])).toEqual([
      ['2026-08', 0],
      ['2026-09', 700],
      ['2026-10', 6000],
    ]);
  });

  it('filters by month, type, category and text, newest first', () => {
    const base = { month: '2026-10', type: 'all' as const, categoryId: null, query: '' };
    expect(filterTransactions(list, DEFAULT_CATEGORIES, base)).toHaveLength(4);
    expect(filterTransactions(list, DEFAULT_CATEGORIES, { ...base, month: null })).toHaveLength(5);
    expect(filterTransactions(list, DEFAULT_CATEGORIES, { ...base, type: 'income' })).toHaveLength(1);
    expect(filterTransactions(list, DEFAULT_CATEGORIES, { ...base, query: 'metro' })[0].note).toBe('Metro');
    expect(filterTransactions(list, DEFAULT_CATEGORIES, { ...base, query: 'food' })).toHaveLength(2);
    expect(filterTransactions(list, DEFAULT_CATEGORIES, { ...base, query: '20' })[0].amount).toBe(2000);
    const sorted = filterTransactions(list, DEFAULT_CATEGORIES, base);
    expect(sorted.map((t) => t.date)).toEqual(['2026-10-03', '2026-10-03', '2026-10-01', '2026-10-01']);
    expect(sorted[0].createdAt).toBe(5);
  });

  it('groups by day with the day net', () => {
    const groups = groupByDay(filterTransactions(list, DEFAULT_CATEGORIES, { month: '2026-10', type: 'all', categoryId: null, query: '' }));
    expect(groups.map((g) => [g.date, g.net])).toEqual([
      ['2026-10-03', -3000],
      ['2026-10-01', 47000],
    ]);
  });

  it('averages per elapsed day this month and per day in past months', () => {
    const now = new Date(2026, 9, 10);
    expect(dailyAverage(100000, '2026-10', now)).toBe(10000);
    expect(dailyAverage(30000, '2026-09', now)).toBe(1000);
    expect(dailyAverage(31000, '2026-09', now)).toBe(1000);
    expect(dailyAverage(30000, '2026-11', now)).toBe(0);
  });

  it('keeps a running balance from the opening amount', () => {
    // Entries: 09-30 food 700; 10-01 salary 50000 and food 3000; 10-03 transport 1000 and food 2000.
    expect(balanceNow(list, 10000, { now: new Date(2026, 9, 3, 12) })).toBe(10000 + 50000 - 6700);
    expect(balanceNow(list, 0, { now: new Date(2026, 9, 2) })).toBe(50000 - 3000 - 700);
    const after = runningBalances(list, 1000);
    expect(after.get(list[4].id)).toBe(300);
    let balance = 1000;
    for (const entry of [...list].sort((a, b) => newestFirst(b, a))) {
      balance += entry.type === 'income' ? entry.amount : -entry.amount;
      expect(after.get(entry.id)).toBe(balance);
    }
    expect(balance).toBe(1000 + 50000 - 6700);
  });

  it('lists cravings skipped most often first', () => {
    const saving = (item: string, amount: number, createdAt: number) => ({ id: `${item}-${createdAt}`, item, amount, date: '2026-10-01', createdAt });
    const picks = frequentCravings([
      saving('Chips', 2000, 1),
      saving('Chocolate cake', 3000, 2),
      saving('chocolate cake', 3500, 3),
      saving('Coffee', 9000, 4),
    ]);
    expect(picks).toEqual([
      { item: 'chocolate cake', amount: 3500, count: 2 },
      { item: 'Coffee', amount: 9000, count: 1 },
      { item: 'Chips', amount: 2000, count: 1 },
    ]);
  });

  it('grades budgets', () => {
    expect(budgetLevel(79, 100)).toBe('ok');
    expect(budgetLevel(80, 100)).toBe('near');
    expect(budgetLevel(100, 100)).toBe('near');
    expect(budgetLevel(101, 100)).toBe('over');
  });

  it('picks clean axis steps', () => {
    expect(niceScale(0)).toEqual({ top: 3, step: 1 });
    expect(niceScale(9000)).toEqual({ top: 10000, step: 5000 });
    expect(niceScale(2400)).toEqual({ top: 3000, step: 1000 });
    expect(niceScale(130)).toEqual({ top: 150, step: 50 });
  });
});

describe('storage', () => {
  it('starts with default categories when nothing is stored', () => {
    const data = loadData(new MemoryStorage());
    expect(data.transactions).toEqual([]);
    expect(data.categories.length).toBe(DEFAULT_CATEGORIES.length);
  });

  it('saves and loads the same data', () => {
    const storage = new MemoryStorage();
    const data = { ...createInitialData('INR'), transactions: [tx({ id: 'a' })] };
    expect(saveData(data, storage)).toBe(true);
    expect(loadData(storage)).toEqual(data);
  });

  it('reports a full storage instead of throwing', () => {
    const storage = new MemoryStorage();
    storage.quota = 10;
    expect(saveData(createInitialData('INR'), storage)).toBe(false);
  });

  it('copes with storage that is missing or refuses access', () => {
    expect(loadData(null).transactions).toEqual([]);
    expect(saveData(createInitialData('INR'), null)).toBe(false);
    const blocked = new MemoryStorage();
    blocked.getItem = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    expect(loadData(blocked).categories.length).toBe(DEFAULT_CATEGORIES.length);
  });

  it('keeps an unreadable copy rather than losing it', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{broken');
    expect(loadData(storage).transactions).toEqual([]);
    const kept = [...Array(storage.length).keys()].map((i) => storage.key(i)!).find((k) => k.includes('unreadable'));
    expect(kept && storage.getItem(kept)).toBe('{broken');
  });

  it('drops invalid entries and repairs category links', () => {
    const data = sanitize({
      categories: [...DEFAULT_CATEGORIES, { id: 'x', name: '', type: 'expense' }, { id: 'exp-food', name: 'Dup', type: 'expense' }],
      transactions: [
        tx({ id: 'ok' }),
        tx({ id: 'ok' }),
        tx({ id: 'neg', amount: -5 }),
        tx({ id: 'float', amount: 1.5 }),
        tx({ id: 'date', date: '2026-02-30' }),
        tx({ id: 'gone', categoryId: 'deleted' }),
        tx({ id: 'wrong-type', type: 'income', categoryId: 'exp-food' }),
        { id: 'junk' },
      ],
      categoryBudgets: { 'exp-food': 5000, 'inc-salary': 100, nope: 1 },
      savings: [
        { id: 's1', item: ' Cake ', amount: 3000, date: '2026-10-01', createdAt: 1 },
        { id: 's1', item: 'Dup', amount: 3000, date: '2026-10-01' },
        { id: 's2', item: '', amount: 500, date: '2026-10-02' },
        { id: 's3', item: 'Free', amount: 0, date: '2026-10-02' },
        { id: 's4', item: 'Bad date', amount: 100, date: 'yesterday' },
      ],
      settings: { currency: 'NOPE', theme: 'purple', monthlyBudget: 0, openingBalance: 1.5 },
    });
    expect(data.transactions.map((t) => t.id)).toEqual(['ok', 'gone', 'wrong-type']);
    expect(data.transactions[1].categoryId).toBe(OTHER_EXPENSE);
    expect(data.transactions[2].categoryId).toBe('inc-other');
    expect(data.categories.filter((c) => c.id === 'exp-food')).toHaveLength(1);
    expect(data.categoryBudgets).toEqual({ 'exp-food': 5000 });
    expect(data.settings.theme).toBe('system');
    expect(data.settings.monthlyBudget).toBeNull();
    expect(data.settings.openingBalance).toBe(0);
    expect(data.savings).toEqual([
      { id: 's1', item: 'Cake', amount: 3000, date: '2026-10-01', createdAt: 1 },
      { id: 's2', item: 'Something I skipped', amount: 500, date: '2026-10-02', createdAt: 0 },
    ]);
  });

  it('keeps a negative opening balance and fills in fields older data lacks', () => {
    expect(sanitize({ settings: { openingBalance: -2500 } }).settings.openingBalance).toBe(-2500);
    const old = sanitize({ transactions: [], settings: { currency: 'INR', theme: 'dark', monthlyBudget: null } });
    expect(old.savings).toEqual([]);
    expect(old.settings.openingBalance).toBe(0);
  });

  it('always keeps the two Other categories', () => {
    const data = sanitize({ categories: [], transactions: [] });
    expect(data.categories.map((c) => c.id).sort()).toEqual(['exp-other', 'inc-other']);
  });

  it('round-trips a backup and refuses other files', () => {
    const data = { ...createInitialData('EUR'), transactions: [tx({ id: 'b' })] };
    expect(parseBackup(serializeBackup(data))).toEqual(data);
    expect(() => parseBackup('not json')).toThrow(/not JSON/);
    expect(() => parseBackup('{"transactions": []}')).toThrow(/not a backup/);
    expect(() => parseBackup('{"app": "expense-tracker", "version": 2, "transactions": []}')).toThrow(/newer/);
  });
});

describe('csv', () => {
  it('quotes, guards against formulas and starts with a BOM', () => {
    const csv = toCSV(
      [tx({ note: 'Lunch, with "Sam"', date: '2026-10-02' }), tx({ note: '=HYPERLINK("x")', amount: 5, date: '2026-10-01' })],
      DEFAULT_CATEGORIES,
      'INR',
    );
    expect(csv.startsWith('\ufeffDate,Type,Category,Amount,Currency,Note,Balance after\r\n')).toBe(true);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[1]).toBe('2026-10-02,Expense,Food & dining,10.00,INR,"Lunch, with ""Sam""",-10.05');
    expect(lines[2]).toBe(`2026-10-01,Expense,Food & dining,0.05,INR,"'=HYPERLINK(""x"")",-0.05`);
  });

  it('starts the balance column from the opening amount', () => {
    const csv = toCSV([tx({ amount: 2500 })], DEFAULT_CATEGORIES, 'INR', 10000);
    expect(csv.trim().split('\r\n')[1].endsWith(',75.00')).toBe(true);
  });
});

describe('sample data', () => {
  it('stays in the past three months and passes validation', () => {
    const now = new Date(2026, 9, 22);
    const list = sampleTransactions('INR', now);
    expect(list.length).toBeGreaterThan(50);
    expect(list.every((t) => t.date >= '2026-08-01' && t.date <= '2026-10-22')).toBe(true);
    expect(sanitize({ transactions: list }).transactions).toHaveLength(list.length);
    expect(list.every((t) => t.amount % 100 === 0)).toBe(true);
    expect(sampleTransactions('USD', now).some((t) => t.amount % 100 !== 0)).toBe(true);
    expect(sampleOpeningBalance('INR')).toBe(500000);
    const savings = sampleSavings('INR', now);
    expect(sanitize({ savings }).savings).toHaveLength(savings.length);
    expect(savings.every((s) => s.date <= '2026-10-22')).toBe(true);
  });
});
