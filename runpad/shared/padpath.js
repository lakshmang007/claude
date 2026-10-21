/**
 * Pad paths are the URL path of a pad without the leading slash, e.g. `lab/prog1.c`.
 * Segments are case-sensitive, like file names. The first segment may not start with
 * `_`, which is reserved for the app's own routes (`/_api`, `/_ws`, `/_assets`).
 */

export const MAX_SEGMENT = 100;
export const MAX_DEPTH = 16;
export const MAX_PATH = 400;

const RESERVED = new Set(['favicon.ico', 'robots.txt', 'index.html']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Turns a URL pathname (or an already-decoded path) into a canonical pad path.
 * Empty segments are dropped (`/a//b/` is `a/b`). Returns null when the path is
 * the home page or not a valid pad.
 * @param {string} raw
 * @param {{ decoded?: boolean }} [opts]
 * @returns {string | null}
 */
export function normalizePadPath(raw, opts = {}) {
  if (typeof raw !== 'string') return null;
  const parts = [];
  for (const piece of raw.split('/')) {
    let seg = piece;
    if (!opts.decoded) {
      try {
        seg = decodeURIComponent(piece);
      } catch {
        return null;
      }
    }
    seg = seg.trim();
    if (!seg) continue;
    if (seg === '.' || seg === '..' || seg.includes('/') || CONTROL.test(seg)) return null;
    if (seg.length > MAX_SEGMENT) return null;
    parts.push(seg);
  }
  if (!parts.length || parts.length > MAX_DEPTH) return null;
  if (parts[0].startsWith('_') || RESERVED.has(parts[0].toLowerCase())) return null;
  const out = parts.join('/');
  return out.length > MAX_PATH ? null : out;
}

/** URL path for a pad: `/` plus each segment percent-encoded. */
export function padUrl(path) {
  return '/' + path.split('/').map(encodeSegment).join('/');
}

/** Like encodeURIComponent, but keeps characters that are safe and readable in a path. */
function encodeSegment(seg) {
  return encodeURIComponent(seg).replace(/%(?:40|3A|2C|2B|24|21|27|28|29|2A)/gi, (m) =>
    decodeURIComponent(m),
  );
}

/** Parent pad path, or null for a top-level pad. */
export function parentPath(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? null : path.slice(0, i);
}

/** Last segment of a pad path. */
export function baseName(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** All ancestors of a path followed by the path itself: `a/b/c` → `a`, `a/b`, `a/b/c`. */
export function selfAndAncestors(path) {
  const parts = path.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** True when `name` looks like a file name (`util.h`, `input.txt`, `Makefile`). */
export function isFileName(name) {
  return /^[^.].*\.[A-Za-z0-9_+-]{1,10}$/.test(name) || /^(Makefile|Dockerfile|README|LICENSE)$/i.test(name);
}

/** Attached files are sub-pads with file names; they open as tabs and are copied next to the program. */
export function isAttachableName(name) {
  return isFileName(name) && !name.startsWith('-') && name.length <= 100;
}
