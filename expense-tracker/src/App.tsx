import { useCallback, useEffect, useState } from 'react';
import { SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import type { DebtKind, TxType } from './types';
import { BalanceSheet } from './components/BalanceSheet';
import { CategorySheet } from './components/CategorySheet';
import { DebtSheet, PaymentSheet, PersonSheet } from './components/DebtSheets';
import { SavingSheet } from './components/SavingSheet';
import { useFeedback } from './components/Feedback';
import { Icon, type IconName } from './components/Icon';
import { TransactionSheet } from './components/TransactionSheet';
import { currentMonth, daysInMonth, monthOf, todayISO } from './lib/dates';
import { isNative } from './lib/install';
import { useNav, type Tab } from './nav';
import { Home } from './screens/Home';
import { People } from './screens/People';
import { Savings } from './screens/Savings';
import { Settings } from './screens/Settings';
import { Tracker } from './screens/Tracker';
import { Transactions } from './screens/Transactions';
import { useStore } from './store';

export interface ListFilter {
  query: string;
  type: TxType | 'all';
  categoryId: string | null;
  allTime: boolean;
}

export type TrackerView = 'day' | 'month';

export interface ScreenProps {
  month: string;
  /** Also moves the selected day into that month. */
  setMonth: (month: string) => void;
  /** The day the daily tracker shows, YYYY-MM-DD. */
  day: string;
  /** Also moves the selected month to that day's month. */
  setDay: (day: string) => void;
  trackerView: TrackerView;
  setTrackerView: (view: TrackerView) => void;
  openTransaction: (id: string) => void;
  addTransaction: (type?: TxType) => void;
  /** Shows the month's transactions in one category. */
  showCategory: (categoryId: string) => void;
  openCategory: (id: string | undefined, type: TxType) => void;
  /** Opens the sheet for setting how much money the person has now. */
  openBalance: () => void;
  /** Opens a skipped craving, or a new one without an id. */
  openSaving: (id?: string) => void;
  /** Opens a debt to edit, or a new one (optionally for a person and of a kind). */
  openDebt: (options: { id?: string; debtKind?: DebtKind; person?: string }) => void;
  openPerson: (key: string) => void;
  goTab: (tab: Tab) => void;
  filter: ListFilter;
  setFilter: (filter: ListFilter) => void;
}

const TABS: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'transactions', label: 'History', icon: 'list' },
  { tab: 'tracker', label: 'Tracker', icon: 'calendar' },
  { tab: 'people', label: 'People', icon: 'people' },
  { tab: 'savings', label: 'Savings', icon: 'jar' },
];

const THEME_COLORS = { light: '#f3f3ef', dark: '#0f0f0e' };

export function App() {
  const store = useStore();
  const { notify } = useFeedback();
  const { tab, overlay, goTab, open, close } = useNav();
  const [month, setMonthState] = useState(currentMonth);
  const [day, setDayState] = useState(todayISO);
  const [trackerView, setTrackerView] = useState<TrackerView>('day');
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

  const setDay = useCallback((next: string) => {
    setDayState(next);
    setMonthState(monthOf(next));
  }, []);

  const setMonth = useCallback((next: string) => {
    setMonthState(next);
    // Today within the current month, otherwise the month's last day.
    setDayState((current) =>
      monthOf(current) === next ? current : next === currentMonth() ? todayISO() : `${next}-${String(daysInMonth(next)).padStart(2, '0')}`,
    );
  }, []);

  const props: ScreenProps = {
    month,
    setMonth,
    day,
    setDay,
    trackerView,
    setTrackerView,
    openTransaction: (id) => open({ kind: 'transaction', id }),
    addTransaction,
    showCategory: (categoryId) => {
      const type = store.data.categories.find((c) => c.id === categoryId)?.type ?? 'all';
      setFilter({ query: '', type, categoryId, allTime: false });
      goTab('transactions');
    },
    openCategory: (id, type) => open({ kind: 'category', id, type }),
    openBalance: () => open({ kind: 'balance' }),
    openSaving: (id) => open({ kind: 'saving', id }),
    openDebt: (options) => open({ kind: 'debt', ...options }),
    openPerson: (key) => open({ kind: 'person', key }),
    goTab,
    filter,
    setFilter,
  };

  const showFab = tab !== 'settings' && tab !== 'people';
  // New entries made while looking at another month land in that month.
  const defaultDate = month === currentMonth() ? todayISO() : `${month}-01`;

  return (
    <div className="app">
      <main className="screen">
        {tab === 'home' && <Home {...props} />}
        {tab === 'transactions' && <Transactions {...props} />}
        {tab === 'tracker' && <Tracker {...props} />}
        {tab === 'people' && <People {...props} />}
        {tab === 'savings' && <Savings {...props} />}
        {tab === 'settings' && <Settings {...props} />}
      </main>

      {showFab && (
        <button
          className="fab"
          onClick={() => (tab === 'savings' ? open({ kind: 'saving' }) : addTransaction())}
          aria-label={tab === 'savings' ? 'Skip a craving' : 'Add transaction'}
        >
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
      {overlay?.kind === 'balance' && <BalanceSheet onClose={close} />}
      {overlay?.kind === 'saving' && <SavingSheet key={overlay.id ?? 'new'} id={overlay.id} onClose={close} />}
      {overlay?.kind === 'debt' && (
        <DebtSheet
          key={overlay.id ?? `new-${overlay.person ?? ''}-${overlay.debtKind ?? ''}`}
          id={overlay.id}
          debtKind={overlay.debtKind}
          person={overlay.person}
          onClose={close}
        />
      )}
      {overlay?.kind === 'person' && (
        <PersonSheet
          personKey={overlay.key}
          onClose={close}
          onPay={(debt) => open({ kind: 'payment', debtId: debt.id })}
          onEdit={(debt) => open({ kind: 'debt', id: debt.id })}
          onAdd={(person, debtKind) => open({ kind: 'debt', person, debtKind })}
        />
      )}
      {overlay?.kind === 'payment' && <PaymentSheet key={overlay.debtId} debtId={overlay.debtId} onClose={close} />}
    </div>
  );
}
