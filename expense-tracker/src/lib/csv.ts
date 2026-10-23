import type { Category, Transaction } from '../types';
import { SCALE } from './money';
import { newestFirst, runningBalances } from './stats';

/** A text cell. A leading = + - @ would run as a formula in a spreadsheet, so it is escaped. */
function text(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const number = (amount: number) => (amount / SCALE).toFixed(2);

/**
 * A spreadsheet-ready export, newest first, with the money left after each entry.
 * Starts with a BOM so Excel reads it as UTF-8.
 */
export function toCSV(transactions: Transaction[], categories: Category[], currency: string, openingBalance = 0): string {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const left = runningBalances(transactions, openingBalance);
  const rows = ['Date,Type,Category,Amount,Currency,Note,Balance after'];
  for (const tx of [...transactions].sort(newestFirst)) {
    rows.push(
      [
        tx.date,
        tx.type === 'income' ? 'Income' : 'Expense',
        text(names.get(tx.categoryId) ?? 'Unknown'),
        number(tx.amount),
        currency,
        text(tx.note),
        number(left.get(tx.id) ?? 0),
      ].join(','),
    );
  }
  return `\ufeff${rows.join('\r\n')}\r\n`;
}
