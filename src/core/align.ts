import { blurBuffer } from './imageops';

/** Horizontal extent of the object in every row (or vertical extent per column when transposed). */
export interface Spans {
  /** Number of rows (or columns) described. */
  count: number;
  /** First and last row that contains any object pixel. */
  first: number;
  last: number;
  lo: Float32Array;
  hi: Float32Array;
}

/**
 * Per-row [left, right] extents of a binary mask, with empty interior rows
 * interpolated and light smoothing so a noisy cut-out does not make the
 * warps jitter.
 */
export function rowSpans(inside: Uint8Array, width: number, height: number, smooth = 1.5): Spans | null {
  return spans(height, width, (r, c) => inside[r * width + c] !== 0, smooth);
}

/** Per-column [top, bottom] extents of a binary mask. */
export function colSpans(inside: Uint8Array, width: number, height: number, smooth = 1.5): Spans | null {
  return spans(width, height, (r, c) => inside[c * width + r] !== 0, smooth);
}

function spans(count: number, len: number, at: (line: number, pos: number) => boolean, smooth: number): Spans | null {
  const lo = new Float32Array(count).fill(NaN);
  const hi = new Float32Array(count).fill(NaN);
  let first = -1;
  let last = -1;
  for (let r = 0; r < count; r++) {
    let a = -1;
    let b = -1;
    for (let c = 0; c < len; c++) {
      if (at(r, c)) {
        if (a < 0) a = c;
        b = c;
      }
    }
    if (a >= 0) {
      lo[r] = a;
      hi[r] = b;
      if (first < 0) first = r;
      last = r;
    }
  }
  if (first < 0) return null;
  // Fill gaps between occupied lines by linear interpolation.
  let prev = first;
  for (let r = first + 1; r <= last; r++) {
    if (Number.isNaN(lo[r])) continue;
    if (r - prev > 1) {
      for (let k = prev + 1; k < r; k++) {
        const t = (k - prev) / (r - prev);
        lo[k] = lo[prev] + (lo[r] - lo[prev]) * t;
        hi[k] = hi[prev] + (hi[r] - hi[prev]) * t;
      }
    }
    prev = r;
  }
  for (let r = 0; r < count; r++) {
    if (r < first) {
      lo[r] = lo[first];
      hi[r] = hi[first];
    } else if (r > last) {
      lo[r] = lo[last];
      hi[r] = hi[last];
    }
  }
  if (smooth > 0) {
    const sl = blurBuffer(lo, count, 1, smooth);
    const sh = blurBuffer(hi, count, 1, smooth);
    // Keep the extreme lines exact so the alignment of the bounding box is preserved.
    for (let r = first + 1; r < last; r++) {
      lo[r] = sl[r];
      hi[r] = sh[r];
    }
  }
  return { count, first, last, lo, hi };
}

/** Fractional position of a line inside the occupied range (0 = first, 1 = last). */
export function spanT(s: Spans, line: number): number {
  return s.last > s.first ? (line - s.first) / (s.last - s.first) : 0.5;
}

/** Line in `s` that corresponds to fraction `t` of its occupied range. */
export function spanLineAt(s: Spans, t: number): number {
  return s.first + t * (s.last - s.first);
}

/** Interpolated span at a fractional line index. */
export function spanAt(s: Spans, line: number): [number, number] {
  const l = Math.max(0, Math.min(s.count - 1, line));
  const a = Math.floor(l);
  const b = Math.min(a + 1, s.count - 1);
  const t = l - a;
  return [s.lo[a] + (s.lo[b] - s.lo[a]) * t, s.hi[a] + (s.hi[b] - s.hi[a]) * t];
}

/** Occupied height (in lines) of a span table, i.e. the bounding-box height. */
export function spanExtent(s: Spans): number {
  return s.last - s.first + 1;
}
