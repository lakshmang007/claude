import type { Category, Transaction } from '../types';
import { SCALE } from './money';
import { newestFirst } from './stats';

function cell(value: string): string {
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A spreadsheet-ready export, newest first. Starts with a BOM so Excel reads it as UTF-8. */
export function toCSV(transactions: Transaction[], categories: Category[], currency: string): string {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const rows = [['Date', 'Type', 'Category', 'Amount', 'Currency', 'Note']];
  for (const tx of [...transactions].sort(newestFirst)) {
    rows.push([
      tx.date,
      tx.type === 'income' ? 'Income' : 'Expense',
      names.get(tx.categoryId) ?? 'Unknown',
      (tx.amount / SCALE).toFixed(2),
      currency,
      tx.note,
    ]);
  }
  return `﻿${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
