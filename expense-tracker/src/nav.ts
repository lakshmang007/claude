import { useCallback, useEffect, useState } from 'react';
import type { TxType } from './types';

export type Tab = 'home' | 'transactions' | 'stats' | 'settings';
const TABS: Tab[] = ['home', 'transactions', 'stats', 'settings'];

export type Overlay =
  | { kind: 'transaction'; id?: string; type?: TxType }
  | { kind: 'category'; id?: string; type: TxType };

interface NavState {
  tab: Tab;
  overlay: Overlay | null;
  /** This entry was pushed on top of Home, so Back can return there. */
  overHome?: boolean;
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

  useEffect(() => {
    // A sheet left open before a reload is not reopened.
    history.replaceState({ ...read(history.state), overlay: null }, '');
    const onPop = (event: PopStateEvent) => setNav(read(event.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const goTab = useCallback((tab: Tab) => {
    const current = read(history.state);
    if (tab === current.tab) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (tab === 'home' && current.overHome) {
      history.back();
      return;
    }
    const next: NavState = { tab, overlay: null, overHome: tab !== 'home' && (current.tab === 'home' || current.overHome) };
    if (current.tab === 'home') history.pushState(next, '');
    else history.replaceState(next, '');
    setNav(next);
    window.scrollTo({ top: 0 });
  }, []);

  const open = useCallback((overlay: Overlay) => {
    const next = { ...read(history.state), overlay };
    history.pushState(next, '');
    setNav(next);
  }, []);

  const close = useCallback(() => {
    if (read(history.state).overlay) history.back();
    else setNav((current) => ({ ...current, overlay: null }));
  }, []);

  return { tab: nav.tab, overlay: nav.overlay, goTab, open, close };
}
