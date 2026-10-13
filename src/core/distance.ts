import type { FloatField } from './types';

const INF = 1e20;

/** 1-D squared distance transform of a sampled function (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Exact Euclidean distance from every inside pixel to the nearest outside pixel.
 * Pixels outside the raster count as outside, so objects touching the border
 * still close up. Outside pixels get 0.
 */
export function distanceTransform(inside: Uint8Array, width: number, height: number): FloatField {
  // Pad by one pixel so the raster border acts as background.
  const W = width + 2;
  const H = height + 2;
  const grid = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ix = x - 1;
      const iy = y - 1;
      const isIn = ix >= 0 && iy >= 0 && ix < width && iy < height && inside[iy * width + ix] !== 0;
      grid[y * W + x] = isIn ? INF : 0;
    }
  }
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) grid[y * W + x] = d[x];
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = Math.sqrt(grid[(y + 1) * W + x + 1]);
  }
  return { width, height, data: out };
}

/**
 * Solves the Poisson equation ∇²h = -1 inside the silhouette with h = 0
 * outside (cascadic Gauss-Seidel/SOR, coarse to fine). 2·sqrt(h) is a smooth
 * "balloon" height field: exactly a hemisphere for a disc, round everywhere
 * else, with no creases where parts of different widths meet.
 */
export function poissonHeight(inside: Uint8Array, width: number, height: number): Float32Array {
  interface Level { inside: Uint8Array; w: number; h: number }
  const levels: Level[] = [{ inside, w: width, h: height }];
  while (Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) > 24 && levels.length < 8) {
    const f = levels[levels.length - 1];
    const w = Math.ceil(f.w / 2);
    const h = Math.ceil(f.h / 2);
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let c = 0;
        let n = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = x * 2 + dx;
            const fy = y * 2 + dy;
            if (fx < f.w && fy < f.h) {
              c += f.inside[fy * f.w + fx];
              n++;
            }
          }
        }
        m[y * w + x] = c * 2 >= n ? 1 : 0;
      }
    }
    levels.push({ inside: m, w, h });
  }

  let sol: Float32Array | null = null;
  let prevW = 0;
  let prevH = 0;
  for (let l = levels.length - 1; l >= 0; l--) {
    const { inside: m, w, h } = levels[l];
    const spacing = 1 << l;
    const rhs = spacing * spacing;
    const cur = new Float32Array(w * h);
    if (sol) {
      // Bilinear upsample of the coarser solution as the initial guess.
      for (let y = 0; y < h; y++) {
        const gy = Math.min(prevH - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
        const y0 = Math.floor(gy);
        const y1 = Math.min(y0 + 1, prevH - 1);
        const ty = gy - y0;
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          const gx = Math.min(prevW - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
          const x0 = Math.floor(gx);
          const x1 = Math.min(x0 + 1, prevW - 1);
          const tx = gx - x0;
          const a = sol[y0 * prevW + x0], b = sol[y0 * prevW + x1], c = sol[y1 * prevW + x0], d = sol[y1 * prevW + x1];
          cur[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        }
      }
    }
    const iters = l === levels.length - 1 ? 4 * Math.max(w, h) + 50 : 40;
    const omega = 1.85;
    for (let it = 0; it < iters; it++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          const l1 = x > 0 ? cur[i - 1] : 0;
          const r1 = x < w - 1 ? cur[i + 1] : 0;
          const u1 = y > 0 ? cur[i - w] : 0;
          const d1 = y < h - 1 ? cur[i + w] : 0;
          const target = (l1 + r1 + u1 + d1 + rhs) / 4;
          cur[i] += omega * (target - cur[i]);
        }
      }
    }
    sol = cur;
    prevW = w;
    prevH = h;
  }
  return sol!;
}
