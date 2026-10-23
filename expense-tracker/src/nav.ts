import { useCallback, useEffect, useRef, useState } from 'react';
import type { DebtKind, TxType } from './types';

export type Tab = 'home' | 'transactions' | 'tracker' | 'people' | 'savings' | 'settings';
const TABS: Tab[] = ['home', 'transactions', 'tracker', 'people', 'savings', 'settings'];

export type Overlay =
  | { kind: 'transaction'; id?: string; type?: TxType }
  | { kind: 'category'; id?: string; type: TxType }
  | { kind: 'balance' }
  | { kind: 'saving'; id?: string }
  | { kind: 'debt'; id?: string; debtKind?: DebtKind; person?: string }
  | { kind: 'person'; key: string }
  | { kind: 'payment'; debtId: string };

interface NavState {
  tab: Tab;
  overlay: Overlay | null;
  /** This entry was pushed on top of Home, so Back can return there. */
  overHome?: boolean;
}

// Some embedding frames refuse history changes. The app then runs on its own state, without Back support.
let historyWorks = true;

function push(state: NavState) {
  try {
    history.pushState(state, '');
  } catch {
    historyWorks = false;
  }
}

function replace(state: NavState) {
  try {
    history.replaceState(state, '');
  } catch {
    historyWorks = false;
  }
}

function read(state: unknown): NavState {
  const s = (state ?? {}) as Partial<NavState>;
  return { tab: TABS.includes(s.tab as Tab) ? (s.tab as Tab) : 'home', overlay: s.overlay ?? null, overHome: s.overHome };
}

/**
 * Tabs and sheets live in the browser history, so the phone's Back gesture
 * closes a sheet, then returns to Home, before it leaves the app.
 */
export function useNav() {
  const [nav, setNav] = useState<NavState>(() => ({ ...read(history.state), overlay: null }));
  const latest = useRef(nav);
  latest.current = nav;
  const current = () => (historyWorks ? read(history.state) : latest.current);

  useEffect(() => {
    // A sheet left open before a reload is not reopened.
    replace({ ...read(history.state), overlay: null });
    const onPop = (event: PopStateEvent) => setNav(read(event.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const goTab = useCallback((tab: Tab) => {
    const now = current();
    if (tab === now.tab) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (tab === 'home' && now.overHome && historyWorks) {
      // Switch now; the popstate that follows lands on the same Home entry. Some frames ignore back().
      setNav({ tab: 'home', overlay: null });
      history.back();
      return;
    }
    const next: NavState = { tab, overlay: null, overHome: tab !== 'home' && (now.tab === 'home' || now.overHome) };
    if (now.tab === 'home') push(next);
    else replace(next);
    setNav(next);
    window.scrollTo({ top: 0 });
  }, []);

  const open = useCallback((overlay: Overlay) => {
    const next = { ...current(), overlay };
    push(next);
    setNav(next);
  }, []);

  const close = useCallback(() => {
    // Close now; back() then drops the sheet's history entry where the frame allows it.
    setNav((now) => ({ ...now, overlay: null }));
    if (historyWorks && read(history.state).overlay) history.back();
  }, []);

  return { tab: nav.tab, overlay: nav.overlay, goTab, open, close };
}
