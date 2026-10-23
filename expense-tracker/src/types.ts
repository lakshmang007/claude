export type TxType = 'expense' | 'income';

export interface Category {
  id: string;
  name: string;
  /** An emoji. */
  icon: string;
  type: TxType;
}

export interface Transaction {
  id: string;
  type: TxType;
  /** Integer hundredths of the currency unit (₹12.50 is 1250). Always positive. */
  amount: number;
  categoryId: string;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  note: string;
  createdAt: number;
}

/**
 * A craving the person skipped: what it was and what it would have cost. That money stays
 * with them, and the app counts it as saved.
 */
export interface Saving {
  id: string;
  item: string;
  /** Integer hundredths, always positive. */
  amount: number;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  createdAt: number;
}

/** `lent`: they have to give money back to you. `borrowed`: you have to give money to them. */
export type DebtKind = 'lent' | 'borrowed';

/** Money paid back on a debt: received from them when you lent, paid to them when you borrowed. */
export interface DebtPayment {
  id: string;
  /** Integer hundredths, always positive. */
  amount: number;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** The money went into or out of "money you have". */
  cash: boolean;
  createdAt: number;
}

/** A note of money owed between the person and someone else. */
export interface Debt {
  id: string;
  /** Who: a name as the person writes it. */
  person: string;
  kind: DebtKind;
  /** Integer hundredths, always positive. */
  amount: number;
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  note: string;
  /** The money changed hands when this was noted, so it moved "money you have". */
  cash: boolean;
  payments: DebtPayment[];
  createdAt: number;
}

export type ThemePref = 'system' | 'light' | 'dark';

export interface Settings {
  /** ISO 4217 code. */
  currency: string;
  theme: ThemePref;
  /** Spending limit per month, in hundredths, or null for none. */
  monthlyBudget: number | null;
  /**
   * Money on hand before the first entry, in hundredths. "Money you have" is this plus all
   * income minus all expenses; correcting that figure adjusts this. Can be negative.
   */
  openingBalance: number;
}

export interface AppData {
  version: 1;
  transactions: Transaction[];
  categories: Category[];
  /** Expense category id → monthly limit in hundredths. */
  categoryBudgets: Record<string, number>;
  /** Skipped cravings, the savings jar. */
  savings: Saving[];
  /** Money to give to people and to get back from them. */
  debts: Debt[];
  settings: Settings;
}
