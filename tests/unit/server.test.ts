import { describe, expect, it } from 'vitest';
import { createApiMiddleware, searchReferences } from '../../server/api.js';
import { fetchPublicImage, isBlockedAddress, sniffImageType, validateUrl } from '../../server/netguard.js';
import { interleave, providers } from '../../server/providers.js';

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '64:ff9b::a00:1', '2002:7f00:1::', 'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );

  it('rejects unsafe URLs before connecting', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com/a.png', 'http://user:pw@example.com/a.png', 'http://127.0.0.1/a.png', 'http://[::1]/a.png', 'http://localhost/a.png', 'http://printer.local/a.png', 'http://example.com:22/a.png', 'nonsense']) {
      expect(() => validateUrl(bad)).toThrow();
    }
    expect(validateUrl('https://upload.wikimedia.org/a.jpg').hostname).toBe('upload.wikimedia.org');
  });

  it('refuses to fetch from loopback even via the full fetcher', async () => {
    await expect(fetchPublicImage('http://127.0.0.1:8080/x.png')).rejects.toThrow(/not allowed/i);
  });
});

describe('image sniffing', () => {
  it('recognises raster formats and rejects SVG/HTML', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
    expect(sniffImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp');
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(Buffer.from('<!doctype html><html>'))).toBeNull();
  });
});

function jsonFetch(body: unknown) {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe('search providers', () => {
  it('parses Wikimedia Commons results', async () => {
    const fetchImpl = jsonFetch({
      query: {
        pages: {
          '2': { pageid: 2, index: 2, title: 'File:Teapot back.jpg', imageinfo: [{ mime: 'image/jpeg', url: 'https://upload.wikimedia.org/b.jpg', thumburl: 'https://upload.wikimedia.org/b_640.jpg', thumbwidth: 640, thumbheight: 480, descriptionurl: 'https://commons.wikimedia.org/wiki/File:B', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }] },
          '1': { pageid: 1, index: 1, title: 'File:Teapot.svg', imageinfo: [{ mime: 'image/svg+xml', url: 'https://upload.wikimedia.org/a.svg' }] },
        },
      },
    });
    const items = await providers.wikimedia.search('teapot', { fetchImpl });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Teapot back', url: 'https://upload.wikimedia.org/b_640.jpg', license: 'CC BY-SA 4.0', source: 'Wikimedia Commons' });
  });

  it('parses Openverse results', async () => {
    const fetchImpl = jsonFetch({ results: [{ id: 'x', title: 'Mug', url: 'https://example.org/mug.jpg', thumbnail: 'https://api.openverse.org/t/x', foreign_landing_url: 'https://example.org/mug', license: 'by', source: 'flickr', width: 800, height: 600 }, { id: 'y', url: 'javascript:alert(1)' }] });
    const items = await providers.openverse.search('mug', { fetchImpl });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: 'https://example.org/mug.jpg', license: 'CC BY', source: 'Openverse · flickr' });
  });

  it('interleaves providers and removes duplicates', () => {
    const a = [{ url: 'u1' }, { url: 'u2' }, { url: 'u3' }];
    const b = [{ url: 'u2' }, { url: 'v1' }];
    expect(interleave([a, b] as never).map((x: { url: string }) => x.url)).toEqual(['u1', 'u2', 'v1', 'u3']);
  });

  it('runs view variants and tags results with a hint', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      const q = new URL(url).searchParams.get('q')!;
      seen.push(q);
      return new Response(JSON.stringify({ results: [{ id: q, title: q, url: `https://example.org/${encodeURIComponent(q)}.jpg` }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await searchReferences('red kettle', { fetchImpl, only: ['openverse'] });
    expect(seen.sort()).toEqual(['red kettle', 'red kettle back view', 'red kettle side view', 'red kettle top view']);
    const hints = Object.fromEntries(res.results.map((r: { title: string; hint: string }) => [r.title, r.hint]));
    expect(hints).toEqual({ 'red kettle': 'any', 'red kettle back view': 'back', 'red kettle side view': 'side', 'red kettle top view': 'top' });
  });

  it('reports provider errors instead of failing the whole search', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const res = await searchReferences('anything-unique-503', { fetchImpl, only: ['wikimedia'], views: false });
    expect(res.results).toEqual([]);
    expect(res.errors[0]).toMatchObject({ provider: 'wikimedia', message: 'HTTP 503' });
  });
});

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
  setHeader(k: string, v: string): void;
  end(b?: unknown): void;
}

async function call(mw: ReturnType<typeof createApiMiddleware>, url: string, method = 'GET') {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b) {
      this.body = b;
    },
  };
  let nextCalled = false;
  await mw({ url, method, socket: { remoteAddress: '1.2.3.4' } } as never, res as never, () => {
    nextCalled = true;
  });
  const json = typeof res.body === 'string' ? JSON.parse(res.body) : undefined;
  return { res, json, nextCalled };
}

describe('API middleware', () => {
  it('passes non-API requests through', async () => {
    const { nextCalled } = await call(createApiMiddleware(), '/index.html');
    expect(nextCalled).toBe(true);
  });

  it('validates search input and uses the search backend', async () => {
    const mw = createApiMiddleware({ search: async (q: string, o: { views: boolean }) => ({ query: q, views: o.views, results: [], errors: [], providers: [] }) });
    expect((await call(mw, '/api/search')).res.statusCode).toBe(400);
    const ok = await call(mw, '/api/search?q=teapot&views=0');
    expect(ok.res.statusCode).toBe(200);
    expect(ok.json).toMatchObject({ query: 'teapot', views: false });
  });

  it('serves proxied images with locked-down headers', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const mw = createApiMiddleware({ fetchImage: async () => ({ buffer: png, contentType: 'image/png' }) });
    const { res } = await call(mw, `/api/image?url=${encodeURIComponent('https://example.org/a.png')}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.body).toBe(png);
  });

  it('maps fetch errors to their status codes and rejects other methods', async () => {
    const mw = createApiMiddleware();
    const bad = await call(mw, `/api/image?url=${encodeURIComponent('http://169.254.169.254/latest')}`);
    expect(bad.res.statusCode).toBe(400);
    expect((await call(mw, '/api/image')).res.statusCode).toBe(400);
    expect((await call(mw, '/api/nope')).res.statusCode).toBe(404);
    expect((await call(mw, '/api/search?q=x', 'POST')).res.statusCode).toBe(405);
  });

  it('rate-limits searches per client', async () => {
    const mw = createApiMiddleware({ searchPerMinute: 2, search: async () => ({ results: [] }) });
    expect((await call(mw, '/api/search?q=a')).res.statusCode).toBe(200);
    expect((await call(mw, '/api/search?q=b')).res.statusCode).toBe(200);
    expect((await call(mw, '/api/search?q=c')).res.statusCode).toBe(429);
  });
});
