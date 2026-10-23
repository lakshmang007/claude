import type { Saving, Transaction } from '../types';
import { todayISO } from './dates';
import { SCALE } from './money';

export const SAMPLE_PREFIX = 'sample-';

/** Roughly what the sample amounts (written in rupees) come to in other currencies. */
const PER_RUPEE: Record<string, number> = {
  INR: 1, PKR: 3.3, NPR: 1.6, BDT: 1.4, LKR: 3.5, JPY: 1.8, KRW: 16, IDR: 190, VND: 300,
  PHP: 0.68, THB: 0.4, MYR: 0.055, CNY: 0.085, HKD: 0.093, AED: 0.044, SAR: 0.045,
};

const EXPENSES: [category: string, note: string, rupees: number, everyDays: number][] = [
  ['exp-food', 'Lunch', 180, 2],
  ['exp-food', 'Coffee', 90, 3],
  ['exp-groceries', 'Weekly groceries', 1400, 7],
  ['exp-transport', 'Metro card top-up', 500, 10],
  ['exp-transport', 'Cab', 260, 6],
  ['exp-shopping', 'T-shirt', 799, 24],
  ['exp-bills', 'Phone recharge', 299, 28],
  ['exp-bills', 'Electricity', 1150, 30],
  ['exp-fun', 'Movie', 350, 14],
  ['exp-education', 'Books', 650, 21],
  ['exp-health', 'Pharmacy', 240, 18],
];

/** A sample amount written in rupees, in hundredths of `currency`: whole units where they are small, cents where they are large. */
function sampleAmount(rupees: number, currency: string): number {
  const rate = PER_RUPEE[currency] ?? 1 / 85;
  return Math.max(1, rate >= 0.5 ? Math.round(rupees * rate) * SCALE : Math.round(rupees * rate * SCALE));
}

/** The money on hand the sample starts from. */
export function sampleOpeningBalance(currency: string): number {
  return sampleAmount(5000, currency);
}

/** About three months of believable entries ending today, for trying the app out. */
export function sampleTransactions(currency: string, now = new Date()): Transaction[] {
  const money = (rupees: number) => sampleAmount(rupees, currency);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const today = todayISO(now);
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const list: Transaction[] = [];
  const add = (date: Date, type: Transaction['type'], categoryId: string, note: string, amount: number) => {
    const iso = todayISO(date);
    if (iso > today) return;
    list.push({ id: `${SAMPLE_PREFIX}${list.length + 1}`, type, amount, categoryId, date: iso, note, createdAt: date.getTime() + list.length });
  };
  for (let month = 0; month < 3; month++) {
    const first = new Date(start.getFullYear(), start.getMonth() + month, 1);
    add(first, 'income', 'inc-allowance', 'Monthly allowance', money(25000));
    add(first, 'expense', 'exp-rent', 'Room rent', money(6000));
    if (month === 1) add(new Date(first.getFullYear(), first.getMonth(), 12), 'income', 'inc-freelance', 'Website fix', money(4000));
  }
  for (let day = new Date(start); todayISO(day) <= today; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    const index = Math.round((day.getTime() - start.getTime()) / 86_400_000);
    for (const [category, note, rupees, every] of EXPENSES) {
      if ((index + note.length) % every !== 0) continue;
      add(day, 'expense', category, note, money(rupees * (0.8 + random() * 0.4)));
    }
  }
  return list;
}

const CRAVINGS: [item: string, rupees: number, daysAgo: number][] = [
  ['Chocolate cake', 30, 0],
  ['Cold coffee', 90, 1],
  ['Chips', 20, 3],
  ['Chocolate cake', 30, 5],
  ['Pizza slice', 120, 8],
  ['Chocolate cake', 30, 12],
];

/** A few skipped cravings over the last two weeks. */
export function sampleSavings(currency: string, now = new Date()): Saving[] {
  return CRAVINGS.map(([item, rupees, daysAgo], i) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    return { id: `${SAMPLE_PREFIX}saving-${i + 1}`, item, amount: sampleAmount(rupees, currency), date: todayISO(date), createdAt: date.getTime() + i };
  });
}
