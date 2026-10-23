import type { Debt } from '../types';

/** What is still to be paid on a debt; never below zero. */
export function remaining(debt: Debt): number {
  return Math.max(0, debt.amount - debt.payments.reduce((sum, p) => sum + p.amount, 0));
}

export const isSettled = (debt: Debt) => remaining(debt) === 0;

/** Names match without regard to case or extra spaces, so "Rahul" and "rahul " are one person. */
export const personKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export interface PersonSummary {
  key: string;
  /** The name as most recently written. */
  name: string;
  /** Still to get back from them. */
  toGet: number;
  /** Still to give to them. */
  toGive: number;
  /** toGet − toGive: positive when they owe you overall. */
  net: number;
  /** Their debts that are not paid back yet. */
  open: number;
  debts: Debt[];
}

/** Everyone with a debt, those with the most money outstanding first, settled people last. */
export function peopleSummary(debts: Debt[]): PersonSummary[] {
  const people = new Map<string, PersonSummary & { latest: number }>();
  for (const debt of debts) {
    const key = personKey(debt.person);
    const person = people.get(key) ?? { key, name: debt.person, toGet: 0, toGive: 0, net: 0, open: 0, debts: [], latest: -Infinity };
    const left = remaining(debt);
    if (debt.kind === 'lent') person.toGet += left;
    else person.toGive += left;
    if (left > 0) person.open += 1;
    if (debt.createdAt >= person.latest) {
      person.latest = debt.createdAt;
      person.name = debt.person.trim();
    }
    person.debts.push(debt);
    people.set(key, person);
  }
  return [...people.values()]
    .map(({ latest: _latest, ...person }) => ({ ...person, net: person.toGet - person.toGive }))
    .sort((a, b) => b.toGet + b.toGive - (a.toGet + a.toGive) || a.name.localeCompare(b.name));
}

/** Totals across everyone. */
export function debtTotals(debts: Debt[]): { toGet: number; toGive: number } {
  let toGet = 0;
  let toGive = 0;
  for (const debt of debts) {
    if (debt.kind === 'lent') toGet += remaining(debt);
    else toGive += remaining(debt);
  }
  return { toGet, toGive };
}

/** A debt's entry and payments as they moved "money you have" (only those marked as cash). */
export function debtCashEvents(debt: Debt): { id: string; date: string; createdAt: number; delta: number }[] {
  const out = debt.kind === 'lent' ? -1 : 1;
  const events = debt.cash ? [{ id: debt.id, date: debt.date, createdAt: debt.createdAt, delta: out * debt.amount }] : [];
  for (const payment of debt.payments) {
    if (payment.cash) events.push({ id: payment.id, date: payment.date, createdAt: payment.createdAt, delta: -out * payment.amount });
  }
  return events;
}
