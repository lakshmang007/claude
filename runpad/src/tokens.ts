import { storageGet, storageSet } from './util';

/**
 * Lock tokens this browser holds, by the path of the lock they open. A token for a lock
 * opens that pad and everything under it.
 */
const KEY = 'runpad.tokens';

function all(): Record<string, string> {
  return storageGet<Record<string, string>>(KEY, {});
}

export function saveToken(lockPath: string, token: string): void {
  storageSet(KEY, { ...all(), [lockPath]: token });
}

export function dropToken(lockPath: string): void {
  const next = all();
  delete next[lockPath];
  storageSet(KEY, next);
}

/** Tokens that may matter for a pad: those of locks on it or its ancestors. */
export function tokensFor(padPath: string): string[] {
  const tokens = all();
  return Object.entries(tokens)
    .filter(([lockPath]) => padPath === lockPath || padPath.startsWith(lockPath + '/'))
    .map(([, token]) => token);
}

const RUN_KEY = 'runpad.runKey';

export function getRunKey(): string {
  return storageGet<string>(RUN_KEY, '');
}

export function setRunKey(key: string): void {
  storageSet(RUN_KEY, key);
}
