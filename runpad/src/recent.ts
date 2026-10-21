import { storageGet, storageSet } from './util';

export interface RecentPad {
  path: string;
  t: number;
}

const KEY = 'runpad.recent';
const MAX = 30;

export function recentPads(): RecentPad[] {
  return storageGet<RecentPad[]>(KEY, []).filter((r) => r && typeof r.path === 'string');
}

export function rememberPad(path: string): void {
  const list = recentPads().filter((r) => r.path !== path);
  list.unshift({ path, t: Date.now() });
  storageSet(KEY, list.slice(0, MAX));
}

export function forgetPad(path: string): void {
  storageSet(
    KEY,
    recentPads().filter((r) => r.path !== path),
  );
}
