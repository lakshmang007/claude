import { useCallback, useEffect, useState } from 'react';
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import type { TxType } from './types';
import { CategorySheet } from './components/CategorySheet';
import { useFeedback } from './components/Feedback';
import { Icon, type IconName } from './components/Icon';
import { TransactionSheet } from './components/TransactionSheet';
import { currentMonth, todayISO } from './lib/dates';
import { isNative } from './lib/install';
import { useNav, type Tab } from './nav';
import { Home } from './screens/Home';
import { Settings } from './screens/Settings';
import { Stats } from './screens/Stats';
import { Transactions } from './screens/Transactions';
import { useStore } from './store';

export interface ListFilter {
  query: string;
  type: TxType | 'all';
  categoryId: string | null;
  allTime: boolean;
}

export interface ScreenProps {
  month: string;
  setMonth: (month: string) => void;
  openTransaction: (id: string) => void;
  addTransaction: (type?: TxType) => void;
  /** Shows the month's transactions in one category. */
  showCategory: (categoryId: string) => void;
  openCategory: (id: string | undefined, type: TxType) => void;
  goTab: (tab: Tab) => void;
  filter: ListFilter;
  setFilter: (filter: ListFilter) => void;
}

const TABS: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'transactions', label: 'History', icon: 'list' },
  { tab: 'stats', label: 'Stats', icon: 'chart' },
  { tab: 'settings', label: 'Settings', icon: 'settings' },
];

const THEME_COLORS = { light: '#f3f3ef', dark: '#0f0f0e' };

export function App() {
  const store = useStore();
  const { notify } = useFeedback();
  const { tab, overlay, goTab, open, close } = useNav();
  const [month, setMonth] = useState(currentMonth);
  const [filter, setFilter] = useState<ListFilter>({ query: '', type: 'all', categoryId: null, allTime: false });
  const { theme } = store.data.settings;

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = theme === 'system' ? THEME_COLORS[meta.media.includes('dark') ? 'dark' : 'light'] : THEME_COLORS[theme];
    });
    if (isNative) {
      const style = theme === 'dark' ? SystemBarsStyle.Dark : theme === 'light' ? SystemBarsStyle.Light : SystemBarsStyle.Default;
      SystemBars.setStyle({ style }).catch(() => undefined);
    }
  }, [theme]);

  // Android's back button walks the app's history, then leaves the app.
  useEffect(() => {
    if (!isNative) return;
    const listener = NativeApp.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) history.back();
      else NativeApp.minimizeApp();
    });
    return () => {
      listener.then((handle) => handle.remove());
    };
  }, []);

  useEffect(() => {
    if (!store.saved) notify("Couldn't save: this device's storage is full or blocked.");
  }, [store.saved, notify]);

  const addTransaction = useCallback((type?: TxType) => open({ kind: 'transaction', type }), [open]);

  const props: ScreenProps = {
    month,
    setMonth,
    openTransaction: (id) => open({ kind: 'transaction', id }),
    addTransaction,
    showCategory: (categoryId) => {
      const type = store.data.categories.find((c) => c.id === categoryId)?.type ?? 'all';
      setFilter({ query: '', type, categoryId, allTime: false });
      goTab('transactions');
    },
    openCategory: (id, type) => open({ kind: 'category', id, type }),
    goTab,
    filter,
    setFilter,
  };

  const showFab = tab !== 'settings' && store.data.transactions.length > 0;
  // New entries made while looking at another month land in that month.
  const defaultDate = month === currentMonth() ? todayISO() : `${month}-01`;

  return (
    <div className="app">
      <main className="screen">
        {tab === 'home' && <Home {...props} />}
        {tab === 'transactions' && <Transactions {...props} />}
        {tab === 'stats' && <Stats {...props} />}
        {tab === 'settings' && <Settings {...props} />}
      </main>

      {showFab && (
        <button className="fab" onClick={() => addTransaction()} aria-label="Add transaction">
          <Icon name="plus" size={28} />
        </button>
      )}

      <nav className="tabbar" aria-label="Sections">
        {TABS.map((item) => (
          <button
            key={item.tab}
            className={`tab ${tab === item.tab ? 'active' : ''}`}
            aria-current={tab === item.tab ? 'page' : undefined}
            onClick={() => goTab(item.tab)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {overlay?.kind === 'transaction' && (
        <TransactionSheet
          key={overlay.id ?? 'new'}
          id={overlay.id}
          initialType={overlay.type}
          defaultDate={defaultDate}
          onClose={close}
        />
      )}
      {overlay?.kind === 'category' && <CategorySheet key={overlay.id ?? 'new'} id={overlay.id} type={overlay.type} onClose={close} />}
    </div>
  );
}
