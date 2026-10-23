import type { AppData, Category, Settings, ThemePref, Transaction, TxType } from '../types';
import { isValidISODate } from './dates';
import { createInitialData, DEFAULT_CATEGORIES, otherCategoryId } from './defaults';
import { isSupportedCurrency } from './money';

export const STORAGE_KEY = 'expense-tracker:data';
const BACKUP_APP = 'expense-tracker';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isType = (value: unknown): value is TxType => value === 'expense' || value === 'income';
const isAmount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function sanitizeCategories(raw: unknown[]): Category[] {
  const seen = new Set<string>();
  const categories: Category[] = [];
  for (const item of raw) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id) || !isType(item.type)) continue;
    const name = text(item.name, 40);
    if (!name) continue;
    seen.add(item.id);
    categories.push({ id: item.id, name, icon: text(item.icon, 16) || '🏷️', type: item.type });
  }
  // Each type keeps its "Other", the fallback for deleted categories.
  for (const fallback of DEFAULT_CATEGORIES.filter((c) => c.id === otherCategoryId(c.type))) {
    if (!seen.has(fallback.id)) categories.push({ ...fallback });
  }
  return categories;
}

function sanitizeTransactions(raw: unknown, categories: Category[]): Transaction[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const transactions: Transaction[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    if (!isType(item.type) || !isAmount(item.amount)) continue;
    if (typeof item.date !== 'string' || !isValidISODate(item.date)) continue;
    const category = typeof item.categoryId === 'string' ? byId.get(item.categoryId) : undefined;
    seen.add(item.id);
    transactions.push({
      id: item.id,
      type: item.type,
      amount: item.amount,
      categoryId: category && category.type === item.type ? category.id : otherCategoryId(item.type),
      date: item.date,
      note: text(item.note, 200),
      createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
    });
  }
  return transactions;
}

function sanitizeSettings(raw: unknown, fallback: Settings): Settings {
  const settings = isObject(raw) ? raw : {};
  const themes: ThemePref[] = ['system', 'light', 'dark'];
  return {
    currency: typeof settings.currency === 'string' && isSupportedCurrency(settings.currency) ? settings.currency : fallback.currency,
    theme: themes.includes(settings.theme as ThemePref) ? (settings.theme as ThemePref) : fallback.theme,
    monthlyBudget: isAmount(settings.monthlyBudget) ? settings.monthlyBudget : null,
  };
}

/** Turns anything parsed from JSON into valid app data, dropping what doesn't fit. */
export function sanitize(raw: unknown): AppData {
  const initial = createInitialData();
  if (!isObject(raw)) return initial;
  const categories = sanitizeCategories(Array.isArray(raw.categories) ? raw.categories : DEFAULT_CATEGORIES);
  const expenseIds = new Set(categories.filter((c) => c.type === 'expense').map((c) => c.id));
  const categoryBudgets: Record<string, number> = {};
  if (isObject(raw.categoryBudgets)) {
    for (const [id, limit] of Object.entries(raw.categoryBudgets)) {
      if (expenseIds.has(id) && isAmount(limit)) categoryBudgets[id] = limit;
    }
  }
  return {
    version: 1,
    transactions: sanitizeTransactions(raw.transactions, categories),
    categories,
    categoryBudgets,
    settings: sanitizeSettings(raw.settings, initial.settings),
  };
}

/** The browser's localStorage, or null where reading it throws (blocked or sandboxed storage). */
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadData(storage: Storage | null = browserStorage()): AppData {
  let stored: string | null = null;
  try {
    stored = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return createInitialData();
  }
  if (stored === null) return createInitialData();
  try {
    return sanitize(JSON.parse(stored));
  } catch {
    // Keep the unreadable copy rather than overwrite it with an empty ledger.
    try {
      storage?.setItem(`${STORAGE_KEY}:unreadable-${Date.now()}`, stored);
    } catch {
      // Nothing more can be done without space.
    }
    return createInitialData();
  }
}

/** Returns false when the browser refuses to store (full, or storage disabled). */
export function saveData(data: AppData, storage: Storage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function serializeBackup(data: AppData, now = new Date()): string {
  return JSON.stringify({ app: BACKUP_APP, exportedAt: now.toISOString(), ...data }, null, 2);
}

/** Reads a backup file's text. Throws an Error with a message fit to show. */
export function parseBackup(json: string): AppData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('That file is not a backup from this app (it is not JSON).');
  }
  if (!isObject(raw) || raw.app !== BACKUP_APP || !Array.isArray(raw.transactions)) {
    throw new Error('That file is not a backup from this app.');
  }
  if (raw.version !== 1) throw new Error('That backup was made by a newer version of the app.');
  return sanitize(raw);
}
