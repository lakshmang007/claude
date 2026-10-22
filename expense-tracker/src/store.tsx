import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { AppData, Category, Settings, Transaction } from './types';
import { newId, otherCategoryId } from './lib/defaults';
import { loadData, saveData, STORAGE_KEY } from './lib/storage';

export type TransactionInput = Omit<Transaction, 'id' | 'createdAt'>;

type Action =
  | { type: 'addTransaction'; tx: Transaction }
  | { type: 'updateTransaction'; id: string; input: TransactionInput }
  | { type: 'deleteTransaction'; id: string }
  | { type: 'restoreTransaction'; tx: Transaction }
  | { type: 'saveCategory'; category: Category }
  | { type: 'deleteCategory'; id: string }
  | { type: 'setCategoryBudget'; id: string; limit: number | null }
  | { type: 'updateSettings'; patch: Partial<Settings> }
  | { type: 'replaceAll'; data: AppData };

function reducer(state: AppData, action: Action): AppData {
  switch (action.type) {
    case 'addTransaction':
    case 'restoreTransaction':
      if (state.transactions.some((tx) => tx.id === action.tx.id)) return state;
      return { ...state, transactions: [...state.transactions, action.tx] };
    case 'updateTransaction':
      return {
        ...state,
        transactions: state.transactions.map((tx) => (tx.id === action.id ? { ...tx, ...action.input } : tx)),
      };
    case 'deleteTransaction':
      return { ...state, transactions: state.transactions.filter((tx) => tx.id !== action.id) };
    case 'saveCategory': {
      const exists = state.categories.some((c) => c.id === action.category.id);
      return {
        ...state,
        categories: exists
          ? state.categories.map((c) => (c.id === action.category.id ? action.category : c))
          : [...state.categories, action.category],
      };
    }
    case 'deleteCategory': {
      const category = state.categories.find((c) => c.id === action.id);
      if (!category || category.id === otherCategoryId(category.type)) return state;
      const fallback = otherCategoryId(category.type);
      const { [action.id]: _removed, ...categoryBudgets } = state.categoryBudgets;
      return {
        ...state,
        categories: state.categories.filter((c) => c.id !== action.id),
        transactions: state.transactions.map((tx) => (tx.categoryId === action.id ? { ...tx, categoryId: fallback } : tx)),
        categoryBudgets,
      };
    }
    case 'setCategoryBudget': {
      const { [action.id]: _previous, ...rest } = state.categoryBudgets;
      return { ...state, categoryBudgets: action.limit ? { ...rest, [action.id]: action.limit } : rest };
    }
    case 'updateSettings':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'replaceAll':
      return action.data;
  }
}

export interface Store {
  data: AppData;
  /** False once the browser has refused to save (storage full or blocked). */
  saved: boolean;
  addTransaction(input: TransactionInput): Transaction;
  updateTransaction(id: string, input: TransactionInput): void;
  deleteTransaction(id: string): Transaction | undefined;
  restoreTransaction(tx: Transaction): void;
  saveCategory(category: Omit<Category, 'id'> & { id?: string }): void;
  deleteCategory(id: string): void;
  setCategoryBudget(id: string, limit: number | null): void;
  updateSettings(patch: Partial<Settings>): void;
  replaceAll(data: AppData): void;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children, storage }: { children: ReactNode; storage?: Storage }) {
  const [data, dispatch] = useReducer(reducer, storage, (s) => loadData(s));
  const [saved, setSaved] = useState(true);
  const fromOtherTab = useRef(false);
  const latest = useRef(data);
  latest.current = data;

  useEffect(() => {
    if (fromOtherTab.current) {
      fromOtherTab.current = false;
      return;
    }
    setSaved(saveData(data, storage));
  }, [data, storage]);

  // Another tab or window of the app changed the data.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      fromOtherTab.current = true;
      dispatch({ type: 'replaceAll', data: loadData(storage) });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storage]);

  const store = useMemo<Store>(
    () => ({
      data,
      saved,
      addTransaction(input) {
        const tx: Transaction = { ...input, id: newId(), createdAt: Date.now() };
        dispatch({ type: 'addTransaction', tx });
        return tx;
      },
      updateTransaction: (id, input) => dispatch({ type: 'updateTransaction', id, input }),
      deleteTransaction(id) {
        const tx = latest.current.transactions.find((t) => t.id === id);
        dispatch({ type: 'deleteTransaction', id });
        return tx;
      },
      restoreTransaction: (tx) => dispatch({ type: 'restoreTransaction', tx }),
      saveCategory: (category) => dispatch({ type: 'saveCategory', category: { ...category, id: category.id ?? newId() } }),
      deleteCategory: (id) => dispatch({ type: 'deleteCategory', id }),
      setCategoryBudget: (id, limit) => dispatch({ type: 'setCategoryBudget', id, limit }),
      updateSettings: (patch) => dispatch({ type: 'updateSettings', patch }),
      replaceAll: (next) => dispatch({ type: 'replaceAll', data: next }),
    }),
    [data, saved],
  );

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside <StoreProvider>');
  return store;
}

/** Category lookup by id, rebuilt only when the categories change. */
export function useCategoryMap(): Map<string, Category> {
  const { categories } = useStore().data;
  return useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
}
