import { describe, expect, it } from 'vitest';
import type { Debt, Transaction } from '../../src/types';
import { debtCashEvents, debtTotals, isSettled, peopleSummary, personKey, remaining } from '../../src/lib/people';
import { sampleDebts } from '../../src/lib/sample';
import { balanceNow, dailySeries, dailyTotals, runningBalances } from '../../src/lib/stats';
import { sanitize } from '../../src/lib/storage';

const debt = (over: Partial<Debt>): Debt => ({
  id: Math.random().toString(36).slice(2),
  person: 'Rahul',
  kind: 'lent',
  amount: 50000,
  date: '2026-10-10',
  note: '',
  cash: true,
  payments: [],
  createdAt: 0,
  ...over,
});

const pay = (amount: number, date = '2026-10-12', cash = true) => ({ id: `p-${amount}-${date}`, amount, date, cash, createdAt: 1 });

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

describe('debts', () => {
  it('works out what is left, never below zero', () => {
    expect(remaining(debt({ payments: [pay(20000)] }))).toBe(30000);
    expect(remaining(debt({ payments: [pay(20000), pay(40000, '2026-10-13')] }))).toBe(0);
    expect(isSettled(debt({ payments: [pay(50000)] }))).toBe(true);
  });

  it('treats names as the same person whatever the case and spacing', () => {
    expect(personKey('  Rahul   Kumar ')).toBe(personKey('rahul kumar'));
  });

  it('sums each person, nets what goes both ways, and lists the biggest first', () => {
    const people = peopleSummary([
      debt({ person: 'rahul', amount: 50000, createdAt: 1 }),
      debt({ person: 'Rahul ', kind: 'borrowed', amount: 20000, createdAt: 2 }),
      debt({ person: 'Priya', kind: 'borrowed', amount: 90000, createdAt: 3 }),
      debt({ person: 'Aman', amount: 10000, payments: [pay(10000)], createdAt: 4 }),
    ]);
    expect(people.map((p) => [p.name, p.toGet, p.toGive, p.net, p.open])).toEqual([
      ['Priya', 0, 90000, -90000, 1],
      ['Rahul', 50000, 20000, 30000, 2],
      ['Aman', 0, 0, 0, 0],
    ]);
  });

  it('totals what is to get back and to give', () => {
    expect(debtTotals([debt({ amount: 50000, payments: [pay(10000)] }), debt({ kind: 'borrowed', amount: 30000 })])).toEqual({
      toGet: 40000,
      toGive: 30000,
    });
  });

  it('moves money you have only for money that changed hands', () => {
    expect(debtCashEvents(debt({ payments: [pay(20000), pay(5000, '2026-10-13', false)] })).map((e) => e.delta)).toEqual([-50000, 20000]);
    expect(debtCashEvents(debt({ kind: 'borrowed', cash: false, payments: [pay(20000)] })).map((e) => e.delta)).toEqual([-20000]);
  });

  it('counts lending and payments in the balance, in date order', () => {
    const lunch = tx({ id: 'lunch', amount: 1000, date: '2026-10-11' });
    const lent = debt({ id: 'lent', date: '2026-10-10', payments: [pay(20000, '2026-10-12')] });
    const now = new Date(2026, 9, 12, 12);
    expect(balanceNow([lunch], 100000, { debts: [lent], now })).toBe(100000 - 50000 - 1000 + 20000);
    // Before the payment's date it doesn't count yet.
    expect(balanceNow([lunch], 100000, { debts: [lent], now: new Date(2026, 9, 11) })).toBe(100000 - 50000 - 1000);
    expect(runningBalances([lunch], 100000, [lent]).get('lunch')).toBe(100000 - 50000 - 1000);
  });

  it('keeps valid debts and payments from a backup and drops the rest', () => {
    const data = sanitize({
      debts: [
        debt({ id: 'a', person: '  Rahul  ', payments: [pay(100), { id: 'bad', amount: -1, date: '2026-10-12' }] as Debt['payments'] }),
        { ...debt({ id: 'b' }), kind: 'gift' },
        { ...debt({ id: 'c' }), person: '' },
        { ...debt({ id: 'd' }), cash: undefined, payments: undefined },
      ],
    });
    expect(data.debts.map((d) => d.id)).toEqual(['a', 'd']);
    expect(data.debts[0].person).toBe('Rahul');
    expect(data.debts[0].payments).toHaveLength(1);
    expect(data.debts[1]).toMatchObject({ cash: false, payments: [] });
  });

  it('has sample debts that pass validation', () => {
    const debts = sampleDebts('INR', new Date(2026, 9, 22));
    expect(sanitize({ debts }).debts).toHaveLength(debts.length);
    expect(debtTotals(debts)).toEqual({ toGet: 30000 + 15000, toGive: 30000 });
  });
});

describe('daily totals', () => {
  const list = [
    tx({ amount: 1000, date: '2026-10-05' }),
    tx({ amount: 500, date: '2026-10-05' }),
    tx({ type: 'income', amount: 9000, date: '2026-10-05' }),
    tx({ amount: 700, date: '2026-10-07' }),
    tx({ amount: 300, date: '2026-09-30' }),
  ];

  it('totals each day of a month', () => {
    const days = dailyTotals(list, '2026-10');
    expect([...days.keys()].sort()).toEqual(['2026-10-05', '2026-10-07']);
    expect(days.get('2026-10-05')).toEqual({ income: 9000, expense: 1500, net: 7500, count: 3 });
  });

  it('lists the last days with empty ones, across a month end', () => {
    expect(dailySeries(list, '2026-10-02', 4).map((d) => [d.date, d.expense])).toEqual([
      ['2026-09-29', 0],
      ['2026-09-30', 300],
      ['2026-10-01', 0],
      ['2026-10-02', 0],
    ]);
  });
});
