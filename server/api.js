import { FetchError, fetchPublicImage } from './netguard.js';
import { enabledProviders, interleave, providers } from './providers.js';

/** Query suffixes used to look for other viewpoints of the same object. */
export const VIEW_VARIANTS = [
  { suffix: '', hint: 'any' },
  { suffix: 'back view', hint: 'back' },
  { suffix: 'side view', hint: 'side' },
  { suffix: 'top view', hint: 'top' },
];

const SEARCH_TTL_MS = 60 * 60 * 1000;
const searchCache = new Map();

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  searchCache.set(key, { at: Date.now(), value });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
}

/** Tiny per-client token bucket so a public deployment cannot be used as an open proxy. */
function rateLimiter(perMinute) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: perMinute, at: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    if (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
    return true;
  };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
}

/**
 * Run the query (and optional viewpoint variants) on every enabled provider.
 * Results carry a `hint` saying which variant found them.
 *
 * @param {string} q
 * @param {{ views?: boolean, perQuery?: number, fetchImpl?: typeof fetch, only?: string[] }} [opts]
 */
export async function searchReferences(q, { views = true, perQuery = 24, fetchImpl, only } = {}) {
  const active = Object.entries(providers).filter(([id, p]) => p.enabled() && (!only || only.includes(id)));
  const variants = views ? VIEW_VARIANTS : VIEW_VARIANTS.slice(0, 1);
  const errors = [];
  const lists = [];
  await Promise.all(
    variants.flatMap((v) =>
      active.map(async ([id, p]) => {
        const query = v.suffix ? `${q} ${v.suffix}` : q;
        const key = `${id}|${query}|${perQuery}`;
        try {
          let items = cacheGet(key);
          if (!items) {
            items = await p.search(query, { limit: perQuery, fetchImpl });
            cacheSet(key, items);
          }
          lists.push({ order: VIEW_VARIANTS.indexOf(v) * 10 + Object.keys(providers).indexOf(id), items: items.map((it) => ({ ...it, hint: v.hint })) });
        } catch (e) {
          errors.push({ provider: id, query, message: e instanceof Error ? e.message : String(e) });
        }
      }),
    ),
  );
  lists.sort((a, b) => a.order - b.order);
  return { query: q, results: interleave(lists.map((l) => l.items)), errors, providers: active.map(([id, p]) => ({ id, label: p.label })) };
}

/**
 * Connect-style middleware serving:
 *   GET /api/health            -> enabled providers
 *   GET /api/search?q=&views=1 -> reference image candidates
 *   GET /api/image?url=        -> same-origin copy of a public image (so the browser may read its pixels)
 */
/**
 * @param {{ searchPerMinute?: number, imagesPerMinute?: number, fetchImage?: (url: string) => Promise<{ buffer: Buffer, contentType: string }>, search?: (q: string, o: { views: boolean }) => Promise<unknown> }} [options]
 */
export function createApiMiddleware(options = {}) {
  const searchLimit = rateLimiter(options.searchPerMinute ?? 30);
  const imageLimit = rateLimiter(options.imagesPerMinute ?? 240);
  const fetchImage = options.fetchImage ?? fetchPublicImage;
  const search = options.search ?? searchReferences;

  return async function api(req, res, next) {
    const url = new URL(req.url || '/', 'http://local');
    if (!url.pathname.startsWith('/api/')) return next?.();
    const client = req.socket?.remoteAddress || 'unknown';
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

    try {
      if (url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, providers: enabledProviders() });
      }

      if (url.pathname === '/api/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
        if (!q) return sendJson(res, 400, { error: 'Missing q' });
        if (!searchLimit(client)) return sendJson(res, 429, { error: 'Too many searches, slow down' });
        const views = url.searchParams.get('views') !== '0';
        const result = await search(q, { views });
        return sendJson(res, 200, result);
      }

      if (url.pathname === '/api/image') {
        const target = url.searchParams.get('url');
        if (!target) return sendJson(res, 400, { error: 'Missing url' });
        if (!imageLimit(client)) return sendJson(res, 429, { error: 'Too many image requests' });
        const { buffer, contentType } = await fetchImage(target);
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        return res.end(req.method === 'HEAD' ? undefined : buffer);
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e instanceof FetchError ? e.status : 500;
      return sendJson(res, status, { error: e instanceof Error ? e.message : 'Internal error' });
    }
  };
}
