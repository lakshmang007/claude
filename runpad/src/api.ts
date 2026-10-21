import { tokensFor } from './tokens';

/** JSON helpers for the server's /_api endpoints. */

export interface LanguageRuntime {
  id: string;
  name: string;
  version: string;
}

export interface ServerConfig {
  maxPadChars: number;
  exec: {
    enabled: boolean;
    terminal: boolean;
    needsKey: boolean;
    sandbox?: string;
    languages: LanguageRuntime[];
    limits?: { runSeconds: number; interactiveSeconds: number; cpuSeconds: number; memoryMb: number; outputKb: number };
  };
}

export interface LockState {
  path: string;
  mode: 'readonly' | 'private';
}

export interface PadInfo {
  path: string;
  canRead: boolean;
  canWrite: boolean;
  lock: LockState | null;
  ownLock: boolean;
  canManageLock: boolean;
  online: number;
  size?: number;
  updatedAt?: number;
  language?: string;
}

export interface ChildPad {
  name: string;
  path: string;
  size: number;
  updatedAt: number;
  exists: boolean;
  hasChildren: boolean;
  locked: boolean;
}

export interface HistoryItem {
  id: number;
  t: number;
  size: number;
  lines: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, padPath: string | null, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (padPath) headers['X-Pad-Tokens'] = tokensFor(padPath).join(',');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data as T;
}

const q = (padPath: string) => `path=${encodeURIComponent(padPath)}`;

export const api = {
  config: () => request<ServerConfig>('GET', '/_api/config', null),
  pad: (p: string) => request<PadInfo>('GET', `/_api/pad?${q(p)}`, p),
  children: (p: string) => request<{ children: ChildPad[] }>('GET', `/_api/children?${q(p)}`, p).then((r) => r.children),
  history: (p: string) => request<{ items: HistoryItem[] }>('GET', `/_api/history?${q(p)}`, p).then((r) => r.items),
  historyItem: (p: string, id: number) => request<{ id: number; t: number; text: string }>('GET', `/_api/history/item?${q(p)}&id=${id}`, p),
  snapshot: (p: string) => request<{ ok: true }>('POST', '/_api/snapshot', p, { path: p }),
  restore: (p: string, id: number) => request<{ ok: true }>('POST', '/_api/history/restore', p, { path: p, id }),
  lock: (p: string, password: string, mode: 'readonly' | 'private') => request<{ token: string; lock: LockState }>('POST', '/_api/lock', p, { path: p, password, mode }),
  unlock: (p: string, password: string) => request<{ token: string; lockPath: string }>('POST', '/_api/unlock', p, { path: p, password }),
  removeLock: (p: string) => request<{ ok: true }>('POST', '/_api/lock/remove', p, { path: p }),
  touch: (p: string, text?: string) => request<{ ok: true }>('POST', '/_api/touch', p, { path: p, text }),
  remove: (p: string) => request<{ ok: true }>('POST', '/_api/delete', p, { path: p }),
};

/** URL path of a pad below /_api/raw, /_api/zip etc. */
export function apiPath(kind: 'raw' | 'zip', padPath: string, extra = ''): string {
  const tokens = tokensFor(padPath);
  const enc = padPath.split('/').map(encodeURIComponent).join('/');
  const params = new URLSearchParams();
  if (tokens.length) params.set('t', tokens.join(','));
  const qs = [params.toString(), extra].filter(Boolean).join('&');
  return `/_api/${kind}/${enc}${qs ? `?${qs}` : ''}`;
}

/** Preview URL: tokens go in the path so relative links inside the page keep them. */
export function previewUrl(padPath: string, file?: string): string {
  const tokens = tokensFor(padPath).join(',') || '-';
  const enc = padPath.split('/').map(encodeURIComponent).join('/');
  return `/_api/preview/${encodeURIComponent(tokens)}/${enc}/${file ? encodeURIComponent(file) : ''}`;
}
