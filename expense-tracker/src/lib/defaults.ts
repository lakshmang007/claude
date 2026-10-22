import type { AppData, Category } from '../types';
import { guessCurrency } from './money';

/** Every transaction of a deleted category moves to its type's "Other". These two can't be deleted. */
export const OTHER_EXPENSE = 'exp-other';
export const OTHER_INCOME = 'inc-other';

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'exp-food', name: 'Food & dining', icon: '🍔', type: 'expense' },
  { id: 'exp-groceries', name: 'Groceries', icon: '🛒', type: 'expense' },
  { id: 'exp-transport', name: 'Transport', icon: '🚌', type: 'expense' },
  { id: 'exp-shopping', name: 'Shopping', icon: '🛍️', type: 'expense' },
  { id: 'exp-bills', name: 'Bills & recharge', icon: '💡', type: 'expense' },
  { id: 'exp-rent', name: 'Rent', icon: '🏠', type: 'expense' },
  { id: 'exp-health', name: 'Health', icon: '💊', type: 'expense' },
  { id: 'exp-education', name: 'Education', icon: '📚', type: 'expense' },
  { id: 'exp-fun', name: 'Entertainment', icon: '🎬', type: 'expense' },
  { id: 'exp-travel', name: 'Travel', icon: '✈️', type: 'expense' },
  { id: 'exp-gifts', name: 'Gifts', icon: '🎁', type: 'expense' },
  { id: OTHER_EXPENSE, name: 'Other', icon: '📦', type: 'expense' },
  { id: 'inc-salary', name: 'Salary', icon: '💼', type: 'income' },
  { id: 'inc-allowance', name: 'Allowance', icon: '👛', type: 'income' },
  { id: 'inc-freelance', name: 'Freelance', icon: '💻', type: 'income' },
  { id: 'inc-investments', name: 'Investments', icon: '📈', type: 'income' },
  { id: 'inc-refunds', name: 'Refunds', icon: '↩️', type: 'income' },
  { id: 'inc-gifts', name: 'Gifts', icon: '🎁', type: 'income' },
  { id: OTHER_INCOME, name: 'Other', icon: '💰', type: 'income' },
];

export function otherCategoryId(type: Category['type']): string {
  return type === 'expense' ? OTHER_EXPENSE : OTHER_INCOME;
}

export function createInitialData(currency = guessCurrency()): AppData {
  return {
    version: 1,
    transactions: [],
    categories: DEFAULT_CATEGORIES.map((category) => ({ ...category })),
    categoryBudgets: {},
    settings: { currency, theme: 'system', monthlyBudget: null },
  };
}

export function newId(): string {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
