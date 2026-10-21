export type DiffLine = { op: ' ' | '+' | '-'; text: string };

/**
 * Line diff of `a` → `b` (Myers' algorithm, after trimming the common start and end).
 * Returns null when the texts differ in more than `maxD` lines.
 */
export function diffLines(a: string[], b: string[], maxD = 1500): DiffLine[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const core = myers(a.slice(start, endA), b.slice(start, endB), maxD);
  if (!core) return null;
  const same = (text: string): DiffLine => ({ op: ' ', text });
  return [...a.slice(0, start).map(same), ...core, ...a.slice(endA).map(same)];
}

function myers(a: string[], b: string[], maxD: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]);
      let x = down ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], last: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = last; d >= 0; d--) {
    const t = trace[d];
    const get = (k: number) => t[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: ' ', text: a[--x] });
      y--;
    }
    if (d > 0) out.push(down ? { op: '+', text: b[y - 1] } : { op: '-', text: a[x - 1] });
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}
