/**
 * Image search providers used to find reference photos of the same object
 * (other viewpoints) on the web. Keyless providers are always on; keyed ones
 * switch on when their environment variables are set.
 *
 * Every provider returns items of the shape:
 *   { id, title, thumbnail, url, pageUrl, width, height, source, license }
 */

const UA = 'TrueForm3D/0.1 (open-source image-to-3D tool; reference image search)';

/**
 * @typedef {{ limit?: number, fetchImpl?: typeof fetch }} SearchOptions
 * @typedef {{ id: string, title: string, thumbnail: string, url: string, pageUrl?: string, width?: number, height?: number, source: string, license?: string }} ImageResult
 * @typedef {{ label: string, enabled: () => boolean, search: (q: string, opts?: SearchOptions) => Promise<ImageResult[]> }} Provider
 */

/**
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 */
async function getJson(url, { headers = {}, timeoutMs = 12000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '').trim();
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

/** @type {Record<string, Provider>} */
export const providers = {
  wikimedia: {
    label: 'Wikimedia Commons',
    enabled: () => true,
    async search(q, { limit = 30, fetchImpl } = {}) {
      const params = new URLSearchParams({
        action: 'query',
        format: 'json',
        generator: 'search',
        gsrsearch: `${q} filetype:bitmap`,
        gsrnamespace: '6',
        gsrlimit: String(Math.min(limit, 50)),
        prop: 'imageinfo',
        iiprop: 'url|size|mime|extmetadata',
        iiurlwidth: '640',
        origin: '*',
      });
      const data = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`, { fetchImpl });
      const pages = Object.values(data?.query?.pages ?? {});
      pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return pages
        .map((p) => {
          const ii = p.imageinfo?.[0];
          if (!ii || !/^image\/(jpeg|png|webp)$/.test(ii.mime)) return null;
          return {
            id: `wikimedia:${p.pageid}`,
            title: stripTags(p.title).replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
            thumbnail: ii.thumburl || ii.url,
            url: ii.thumburl || ii.url,
            pageUrl: ii.descriptionurl,
            width: ii.thumbwidth || ii.width,
            height: ii.thumbheight || ii.height,
            source: 'Wikimedia Commons',
            license: stripTags(ii.extmetadata?.LicenseShortName?.value) || undefined,
          };
        })
        .filter(Boolean);
    },
  },

  openverse: {
    label: 'Openverse',
    enabled: () => true,
    async search(q, { limit = 30, fetchImpl } = {}) {
      const params = new URLSearchParams({ q, page_size: String(Math.min(limit, 50)), mature: 'false' });
      const headers = process.env.OPENVERSE_TOKEN ? { Authorization: `Bearer ${process.env.OPENVERSE_TOKEN}` } : {};
      const data = await getJson(`https://api.openverse.org/v1/images/?${params}`, { headers, fetchImpl });
      return (data?.results ?? [])
        .filter((r) => isHttp(r.url))
        .map((r) => ({
          id: `openverse:${r.id}`,
          title: stripTags(r.title) || 'Untitled',
          thumbnail: r.thumbnail || r.url,
          url: r.url,
          pageUrl: r.foreign_landing_url,
          width: r.width,
          height: r.height,
          source: `Openverse · ${r.source || r.provider || 'web'}`,
          license: r.license ? `CC ${String(r.license).toUpperCase()}` : undefined,
        }));
    },
  },

  brave: {
    label: 'Brave Search',
    enabled: () => !!process.env.BRAVE_API_KEY,
    async search(q, { limit = 30, fetchImpl } = {}) {
      const params = new URLSearchParams({ q, count: String(Math.min(limit, 100)), safesearch: 'strict' });
      const data = await getJson(`https://api.search.brave.com/res/v1/images/search?${params}`, {
        headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY },
        fetchImpl,
      });
      return (data?.results ?? [])
        .map((r, i) => {
          const url = r.properties?.url;
          if (!isHttp(url)) return null;
          return {
            id: `brave:${i}:${url}`,
            title: stripTags(r.title) || 'Image',
            thumbnail: r.thumbnail?.src || url,
            url,
            pageUrl: r.url,
            width: r.properties?.width,
            height: r.properties?.height,
            source: `Brave · ${r.source || 'web'}`,
          };
        })
        .filter(Boolean);
    },
  },

  google: {
    label: 'Google Programmable Search',
    enabled: () => !!(process.env.GOOGLE_CSE_KEY && process.env.GOOGLE_CSE_CX),
    async search(q, { limit = 30, fetchImpl } = {}) {
      const out = [];
      for (let start = 1; start <= Math.min(limit, 30); start += 10) {
        const params = new URLSearchParams({
          key: process.env.GOOGLE_CSE_KEY,
          cx: process.env.GOOGLE_CSE_CX,
          q,
          searchType: 'image',
          num: '10',
          start: String(start),
          safe: 'active',
        });
        const data = await getJson(`https://www.googleapis.com/customsearch/v1?${params}`, { fetchImpl });
        const items = data?.items ?? [];
        for (const r of items) {
          if (!isHttp(r.link)) continue;
          out.push({
            id: `google:${r.link}`,
            title: stripTags(r.title) || 'Image',
            thumbnail: r.image?.thumbnailLink || r.link,
            url: r.link,
            pageUrl: r.image?.contextLink,
            width: r.image?.width,
            height: r.image?.height,
            source: `Google · ${r.displayLink || 'web'}`,
          });
        }
        if (items.length < 10) break;
      }
      return out;
    },
  },

  serpapi: {
    label: 'SerpApi (Google Images)',
    enabled: () => !!process.env.SERPAPI_KEY,
    async search(q, { limit = 30, fetchImpl } = {}) {
      const params = new URLSearchParams({ engine: 'google_images', q, api_key: process.env.SERPAPI_KEY, safe: 'active' });
      const data = await getJson(`https://serpapi.com/search.json?${params}`, { fetchImpl, timeoutMs: 20000 });
      return (data?.images_results ?? [])
        .slice(0, limit)
        .filter((r) => isHttp(r.original))
        .map((r) => ({
          id: `serpapi:${r.original}`,
          title: stripTags(r.title) || 'Image',
          thumbnail: r.thumbnail || r.original,
          url: r.original,
          pageUrl: r.link,
          width: r.original_width,
          height: r.original_height,
          source: `Google · ${r.source || 'web'}`,
        }));
    },
  },
};

export function enabledProviders() {
  return Object.entries(providers)
    .filter(([, p]) => p.enabled())
    .map(([id, p]) => ({ id, label: p.label }));
}

/** Round-robin merge so one provider cannot crowd out the others; dedupe by URL. */
export function interleave(lists) {
  const out = [];
  const seen = new Set();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) {
      const item = l[i];
      if (!item) continue;
      const key = item.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
