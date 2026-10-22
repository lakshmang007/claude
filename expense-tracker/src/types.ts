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

export type ThemePref = 'system' | 'light' | 'dark';

export interface Settings {
  /** ISO 4217 code. */
  currency: string;
  theme: ThemePref;
  /** Spending limit per month, in hundredths, or null for none. */
  monthlyBudget: number | null;
}

export interface AppData {
  version: 1;
  transactions: Transaction[];
  categories: Category[];
  /** Expense category id → monthly limit in hundredths. */
  categoryBudgets: Record<string, number>;
  settings: Settings;
}
