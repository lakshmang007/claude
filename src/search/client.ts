export interface SearchResult {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  pageUrl?: string;
  width?: number;
  height?: number;
  source: string;
  license?: string;
  /** Which query variant found it: 'any' | 'back' | 'side' | 'top'. */
  hint: 'any' | 'back' | 'side' | 'top';
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  errors: { provider: string; query: string; message: string }[];
  providers: { id: string; label: string }[];
}

export async function searchReferences(q: string, views = true): Promise<SearchResponse> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&views=${views ? 1 : 0}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Search failed (${res.status})`);
  return body as SearchResponse;
}

export async function apiHealth(): Promise<{ ok: boolean; providers: { id: string; label: string }[] } | null> {
  try {
    const res = await fetch('/api/health');
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Same-origin URL for a remote image, so its pixels can be read from a canvas. */
export function proxied(url: string): string {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  try {
    const u = new URL(url, location.href);
    if (u.origin === location.origin) return u.toString();
  } catch {
    // not a URL; let the server reject it
  }
  return `/api/image?url=${encodeURIComponent(url)}`;
}

/** Links for searching in the user's own browser; dropped images come back via drag & drop. */
export function browserSearchLinks(q: string): { label: string; href: string }[] {
  const e = encodeURIComponent(q);
  return [
    { label: 'Google Images', href: `https://www.google.com/search?tbm=isch&q=${e}` },
    { label: 'Bing Images', href: `https://www.bing.com/images/search?q=${e}` },
    { label: 'DuckDuckGo', href: `https://duckduckgo.com/?q=${e}&iax=images&ia=images` },
    { label: 'Yandex', href: `https://yandex.com/images/search?text=${e}` },
  ];
}
