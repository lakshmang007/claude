import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * SSRF protection for the image proxy: only public unicast addresses may be
 * contacted. The check runs inside the socket's DNS lookup, so a hostname
 * cannot resolve to a public address during validation and a private one
 * during connect (DNS rebinding).
 */

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isBlockedV4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

function expandV6(ip) {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4).
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.slice(0, -v4[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = addr.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}

function isBlockedV6(ip) {
  const p = expandV6(ip);
  if (p.length !== 8 || p.some((x) => Number.isNaN(x))) return true;
  const allZeroPrefix = p.slice(0, 5).every((x) => x === 0);
  if (allZeroPrefix && p[5] === 0xffff) {
    // IPv4-mapped.
    return isBlockedV4(`${p[6] >> 8}.${p[6] & 255}.${p[7] >> 8}.${p[7] & 255}`);
  }
  if (p.every((x) => x === 0)) return true; // ::
  if (p.slice(0, 7).every((x) => x === 0) && p[7] === 1) return true; // ::1
  if ((p[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((p[0] & 0xff00) === 0xff00) return true; // multicast
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true; // documentation
  if (p[0] === 0x0064 && p[1] === 0xff9b) return true; // NAT64 (can reach private v4)
  if (p[0] === 0x2002) return true; // 6to4 (embeds arbitrary v4)
  if (allZeroPrefix && p[5] === 0) return true; // IPv4-compatible (deprecated)
  return false;
}

export function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const ok = list.filter((a) => !isBlockedAddress(a.address));
    if (!ok.length) {
      const e = new Error(`Refusing to connect to non-public address for ${hostname}`);
      e.code = 'EBLOCKED';
      return callback(e);
    }
    if (options.all) return callback(null, ok);
    return callback(null, ok[0].address, ok[0].family);
  });
}

export class FetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError('Invalid URL', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http(s) URLs are allowed', 400);
  if (u.username || u.password) throw new FetchError('Credentials in URLs are not allowed', 400);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (![80, 443, 8080, 8443].includes(port)) throw new FetchError('Port not allowed', 400);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) throw new FetchError('Address not allowed', 400);
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new FetchError('Host not allowed', 400);
  return u;
}

const MAGIC = [
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: (b) => b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { type: 'image/bmp', bytes: [0x42, 0x4d] },
  { type: 'image/avif', bytes: null, extra: (b) => b.subarray(4, 12).toString('latin1').startsWith('ftypavi') },
];

/** Identify a raster image by its leading bytes; returns null for anything else (SVG included). */
export function sniffImageType(buf) {
  for (const m of MAGIC) {
    if (m.bytes && !m.bytes.every((v, i) => buf[i] === v)) continue;
    if (m.extra && !m.extra(buf)) continue;
    if (!m.bytes && !m.extra) continue;
    return m.type;
  }
  return null;
}

/**
 * Download an image from a public URL with redirect re-validation, size and
 * time limits. Resolves to { buffer, contentType }.
 */
export function fetchPublicImage(rawUrl, { maxBytes = 15 * 1024 * 1024, timeoutMs = 15000, maxRedirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (url, redirectsLeft) => {
      let u;
      try {
        u = validateUrl(url);
      } catch (e) {
        return reject(e);
      }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(
        u,
        {
          lookup: guardedLookup,
          timeout: timeoutMs,
          headers: {
            'User-Agent': 'TrueForm3D/0.1 (reference image fetcher)',
            Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new FetchError('Too many redirects'));
            return attempt(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
          }
          if (status !== 200) {
            res.resume();
            return reject(new FetchError(`Upstream responded ${status}`, 502));
          }
          const declared = Number(res.headers['content-length'] || 0);
          if (declared > maxBytes) {
            res.destroy();
            return reject(new FetchError('Image too large', 413));
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
              res.destroy();
              reject(new FetchError('Image too large', 413));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const contentType = sniffImageType(buffer);
            if (!contentType) return reject(new FetchError('Not a supported raster image', 415));
            resolve({ buffer, contentType });
          });
          res.on('error', (e) => reject(new FetchError(e.message)));
        },
      );
      req.on('timeout', () => req.destroy(new FetchError('Upstream timed out', 504)));
      req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError(e.code === 'EBLOCKED' ? 'Address not allowed' : e.message, e.code === 'EBLOCKED' ? 400 : 502)));
    };
    attempt(rawUrl, maxRedirects);
  });
}
