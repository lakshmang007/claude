import { spanAt, spanExtent, spanLineAt, spanT, type Spans } from './align';
import { distanceTransform, poissonHeight } from './distance';
import { blurBuffer, clamp, maskedBlur, percentile, pushPull, resizeFloat, sampleFloat } from './imageops';
import type { ByteField, FloatField } from './types';

/** Distance and inflation information of a binary silhouette on a grid. */
export interface Silhouette {
  width: number;
  height: number;
  inside: Uint8Array;
  /** Distance from each pixel centre to the silhouette edge (grid px, >= 0.5 inside). */
  dist: Float32Array;
  /** Balloon height (grid px): circular cross-sections, a hemisphere for a disc. */
  infl: Float32Array;
  /** Smooth local cross-section radius (grid px). */
  radius: Float32Array;
}

/**
 * @param fineDist optional distance-to-outline per grid pixel (grid px) measured
 *   on the full-resolution cut-out. Near the rim the circular profile is very
 *   steep, so pixel-quantised distances would print ridges into the surface.
 */
export function analyseSilhouette(inside: Uint8Array, width: number, height: number, fineDist?: Float32Array): Silhouette {
  const D = distanceTransform(inside, width, height);
  const P = poissonHeight(inside, width, height);
  const n = width * height;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    // Pixel centres of the outermost ring are half a pixel from the true edge.
    dist[i] = fineDist ? Math.max(0.05, fineDist[i]) : Math.max(0.5, D.data[i] - 0.5);
  }

  // 2·sqrt(P) is exact for discs but √2 too thick for long strips (P peaks at w²/2
  // instead of w²/4). On the medial axis the ratio D / (2·sqrt(P)) tells the two
  // apart; spread it smoothly over the shape so every cross-section is circular.
  // The medial-axis distance itself is the local cross-section radius.
  const k = new Float32Array(n);
  const radius = new Float32Array(n);
  const w = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!inside[i] || P[i] <= 0) continue;
      const di = D.data[i];
      let ridge = true;
      for (let dy = -1; dy <= 1 && ridge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < width && yy < height && D.data[yy * width + xx] > di + 0.35) {
            ridge = false;
            break;
          }
        }
      }
      if (ridge && di >= 1.5) {
        k[i] = di / (2 * Math.sqrt(P[i]));
        radius[i] = di - 0.5;
        w[i] = 1;
      }
    }
  }
  const sigma = Math.max(2, Math.max(width, height) * 0.03);
  const smoothK = blurBuffer(pushPull(k, w, width, height, 1), width, height, sigma);
  const smoothR = blurBuffer(pushPull(radius, w, width, height, 1), width, height, sigma);
  const infl = new Float32Array(n);
  const radiusOut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    const interior = 2 * Math.sqrt(Math.max(0, P[i])) * clamp(smoothK[i] || 1, 0.6, 1.1);
    // Close to the outline use the circle profile with the accurate distance.
    const d = dist[i];
    const R = Math.max(d, smoothR[i] || d);
    radiusOut[i] = R;
    const rim = Math.sqrt(Math.max(0, d * (2 * R - d)));
    const t = clamp((d - 2) / 3, 0, 1);
    infl[i] = rim + (interior - rim) * t * t * (3 - 2 * t);
  }
  return { width, height, inside, dist, infl, radius: radiusOut };
}

/**
 * Unit normals (3 per grid pixel) of a height layer z = zRim ± h. Inside, the
 * gradient comes from finite differences. Near the outline the circular
 * profile is nearly vertical and the outer vertices were snapped to the
 * outline, so finite differences there are meaningless; use the profile's
 * analytic slope along the smooth distance gradient instead.
 *
 * @param signedDist smooth signed distance to the outline (grid px, + inside).
 */
export function layerNormals(s: Silhouette, signedDist: Float32Array, h: Float32Array, zRim: Float32Array, sign: 1 | -1, dist: Float32Array = s.dist): Float32Array {
  const { width: W, height: H, inside, infl, radius } = s;
  const out = new Float32Array(W * H * 3);
  // How much of the inflation profile this layer uses (thickness × roundness, side scaling ...),
  // measured away from the rim and spread smoothly.
  const cRaw = new Float32Array(W * H);
  const cW = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    if (inside[p] && dist[p] >= 3 && infl[p] > 1e-3) {
      cRaw[p] = clamp(h[p] / infl[p], 0, 3);
      cW[p] = 1;
    }
  }
  const cField = cW.some((v) => v) ? blurBuffer(pushPull(cRaw, cW, W, H, 1), W, H, 2) : null;
  const z = (i: number, j: number) => zRim[j * W + i] + sign * h[j * W + i];
  const ok = (i: number, j: number) => i >= 0 && j >= 0 && i < W && j < H && inside[j * W + i] !== 0;
  const fd = (f: (i: number, j: number) => number, i: number, j: number, di: number, dj: number) => {
    const a = ok(i - di, j - dj);
    const b = ok(i + di, j + dj);
    if (a && b) return (f(i + di, j + dj) - f(i - di, j - dj)) / 2;
    if (b) return f(i + di, j + dj) - f(i, j);
    if (a) return f(i, j) - f(i - di, j - dj);
    return 0;
  };
  const rimZ = (i: number, j: number) => zRim[j * W + i];
  const sd = (i: number, j: number) => signedDist[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p]) continue;
      let dzdi = fd(z, i, j, 1, 0);
      let dzdj = fd(z, i, j, 0, 1);
      const d = dist[p];
      const wA = 1 - clamp((d - 2) / 2, 0, 1);
      if (wA > 0) {
        let gi = (sd(i + 1, j) - sd(i - 1, j)) / 2;
        let gj = (sd(i, j + 1) - sd(i, j - 1)) / 2;
        const gl = Math.hypot(gi, gj);
        if (gl > 0.2) {
          gi /= gl;
          gj /= gl;
          const R = radius[p];
          const f = Math.sqrt(Math.max(1e-6, d * (2 * R - d)));
          const c = cField ? clamp(cField[p], 0, 3) : clamp(h[p] / Math.max(1e-3, infl[p]), 0, 3);
          const slope = Math.min(40, (c * Math.max(0, R - d)) / f);
          const ai = fd(rimZ, i, j, 1, 0) + sign * slope * gi;
          const aj = fd(rimZ, i, j, 0, 1) + sign * slope * gj;
          dzdi += (ai - dzdi) * wA;
          dzdj += (aj - dzdj) * wA;
        }
      }
      // World x = i, y = -j. Front normal ∝ (-dz/di, dz/dj, 1); back ∝ (dz/di, -dz/dj, -1).
      const nx = -sign * dzdi;
      const ny = sign * dzdj;
      const nz = sign;
      const len = Math.hypot(nx, ny, nz);
      out[p * 3] = nx / len;
      out[p * 3 + 1] = ny / len;
      out[p * 3 + 2] = nz / len;
    }
  }
  return out;
}

/**
 * Shape prior used where nothing better is known and as the fallback when no
 * depth network is available: sqrt of the Poisson solution (see poissonHeight).
 */
export function inflation(s: Silhouette): Float32Array {
  return s.infl;
}

export interface Relief {
  /** Bulge relative to the silhouette rim, in normalised depth units (≈ -1..1). */
  rel: Float32Array;
  /** Normalised depth of the rim surface interpolated across the object. */
  rim: Float32Array;
}

/**
 * Turn a relative inverse-depth map (larger = closer, any scale/offset) into a
 * bulge relative to the silhouette rim. The rim depth is sampled just inside
 * the edge (where the depth network is not contaminated by background) and
 * interpolated across the interior with push-pull + smoothing.
 */
export function depthRelief(depth: FloatField, s: Silhouette): Relief | null {
  const { width, height, inside, dist } = s;
  const d = resizeFloat(depth, width, height).data;
  const core = (i: number) => inside[i] !== 0 && dist[i] >= 1.5;
  let lo = percentile(d, 2, core);
  let hi = percentile(d, 98, core);
  if (!(hi - lo > 1e-6)) {
    lo = percentile(d, 0, (i) => inside[i] !== 0);
    hi = percentile(d, 100, (i) => inside[i] !== 0);
    if (!(hi - lo > 1e-6)) return null;
  }
  const n = width * height;
  const dn = new Float32Array(n);
  for (let i = 0; i < n; i++) dn[i] = clamp((d[i] - lo) / (hi - lo), -0.25, 1.25);

  const maxDist = percentile(dist, 100, (i) => inside[i] !== 0);
  const bandLo = Math.min(1.5, maxDist * 0.3);
  const bandHi = Math.max(bandLo + 1, Math.min(3.5, maxDist * 0.6));
  const wts = new Float32Array(n);
  for (let i = 0; i < n; i++) if (inside[i] && dist[i] >= bandLo && dist[i] <= bandHi) wts[i] = 1;
  const rimRaw = pushPull(dn, wts, width, height, 1);
  const rim = blurBuffer(rimRaw, width, height, Math.max(2, Math.min(width, height) * 0.02));
  const rel = new Float32Array(n);
  for (let i = 0; i < n; i++) rel[i] = inside[i] ? dn[i] - rim[i] : 0;
  return { rel, rim };
}

export interface ShapeParams {
  thickness: number;
  depthStrength: number;
  roundness: number;
  keepTilt: boolean;
  smoothing: number;
  shadingDetail: number;
}

export interface FrontShape {
  /** Front bulge above the rim surface (grid px, may be negative for concavities). */
  hF: Float32Array;
  /** Rim surface depth (grid px). */
  zRim: Float32Array;
  /** Prior inflation height (grid px), reused for the back. */
  infl: Float32Array;
  /** Calibration from normalised depth units to grid px (0 when no depth). */
  scale: number;
}

export function frontShape(s: Silhouette, relief: Relief | null, luminance: Float32Array | null, p: ShapeParams): FrontShape {
  const n = s.width * s.height;
  const infl = inflation(s);
  const hF = new Float32Array(n);
  const zRim = new Float32Array(n);
  const isIn = (i: number) => s.inside[i] !== 0;
  let scale = 0;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = s.inside[i] ? 1 : 0;
  if (relief) {
    const inflRef = percentile(infl, 95, isIn);
    const relRef = Math.max(0.05, percentile(relief.rel, 95, isIn));
    scale = inflRef / relRef;
    const rimMean = meanInside(relief.rim, s.inside);
    // Smooth only the network's relief; the inflation prior is already smooth and
    // blurring it would make the rim depend on the pixel staircase of the outline.
    const ml = new Float32Array(n);
    for (let i = 0; i < n; i++) if (s.inside[i]) ml[i] = relief.rel[i] * scale * p.depthStrength;
    const mlSmooth = maskedBlur(ml, w, s.width, s.height, p.smoothing);
    for (let i = 0; i < n; i++) {
      if (!s.inside[i]) continue;
      // Fade the relief out at the outline so front and back meet cleanly.
      const fade = Math.min(1, s.dist[i] / 2);
      hF[i] = p.thickness * ((1 - p.roundness) * mlSmooth[i] * fade + p.roundness * infl[i]);
      zRim[i] = p.keepTilt ? (relief.rim[i] - rimMean) * scale * p.depthStrength * p.thickness : 0;
    }
  } else {
    for (let i = 0; i < n; i++) if (s.inside[i]) hF[i] = p.thickness * infl[i];
  }
  if (luminance && p.shadingDetail > 0) {
    const blurred = blurBuffer(luminance, s.width, s.height, 2.5);
    const amp = p.shadingDetail * Math.max(s.width, s.height) * 0.04;
    for (let i = 0; i < n; i++) {
      if (!s.inside[i]) continue;
      // Fade detail out towards the rim so the seam stays clean.
      const fade = Math.min(1, s.dist[i] / 3);
      hF[i] += (luminance[i] - blurred[i]) * amp * fade;
    }
  }
  const rimSmoothed = maskedBlur(zRim, w, s.width, s.height, Math.max(1, p.smoothing));
  return { hF, zRim: rimSmoothed, infl, scale };
}

function meanInside(v: Float32Array, inside: Uint8Array): number {
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < v.length; i++) {
    if (inside[i]) {
      sum += v[i];
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

/**
 * Maps the front grid onto a reference photo of the back. The back view sees
 * the object mirrored, so x is reversed inside each row's span.
 */
export interface BackWarp {
  frontRows: Spans;
  refRows: Spans;
}

export function backWarpCoord(w: BackWarp, x: number, y: number): [number, number] {
  const t = spanT(w.frontRows, y);
  const ry = spanLineAt(w.refRows, clamp(t, 0, 1));
  const [fl, fr] = spanAt(w.frontRows, y);
  const [bl, br] = spanAt(w.refRows, ry);
  const u = fr > fl ? (x - fl) / (fr - fl) : 0.5;
  return [br - u * (br - bl), ry];
}

/** Back bulge (grid px) warped from a back reference relief computed on the reference's own grid. */
export function backFromReference(
  s: Silhouette,
  frontRows: Spans,
  refRelief: Relief,
  refRows: Spans,
  refGridW: number,
  refGridH: number,
  front: FrontShape,
  p: ShapeParams,
): Float32Array {
  const n = s.width * s.height;
  const warped = new Float32Array(n);
  const field: FloatField = { width: refGridW, height: refGridH, data: refRelief.rel };
  const warp: BackWarp = { frontRows, refRows };
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const i = y * s.width + x;
      if (!s.inside[i]) continue;
      const [rx, ry] = backWarpCoord(warp, x, y);
      warped[i] = sampleFloat(field, rx, ry);
    }
  }
  const isIn = (i: number) => s.inside[i] !== 0;
  const inflRef = percentile(front.infl, 95, isIn);
  const relRef = Math.max(0.05, percentile(warped, 95, isIn));
  const scale = inflRef / relRef;
  const w = new Float32Array(n);
  const ml = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!s.inside[i]) continue;
    w[i] = 1;
    ml[i] = Math.max(0, warped[i]) * scale * p.depthStrength;
  }
  const mlSmooth = maskedBlur(ml, w, s.width, s.height, p.smoothing);
  const hB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!s.inside[i]) continue;
    const fade = Math.min(1, s.dist[i] / 2);
    hB[i] = p.thickness * ((1 - p.roundness) * mlSmooth[i] * fade + p.roundness * front.infl[i]);
  }
  return hB;
}

/** Thickness (front-to-back extent) seen in a side or top reference, resampled per front row/column. */
export interface ExtentConstraint {
  /** 'rows' constrains each front row (side views), 'cols' each front column (top view). */
  axis: 'rows' | 'cols';
  values: Float32Array;
}

/**
 * Side views reveal how deep the object really is at every height. Scale the
 * bulges row by row (and column by column for a top view) so the model's
 * front-to-back extent matches the reference silhouette.
 */
export function applyExtentConstraints(s: Silhouette, hF: Float32Array, hB: Float32Array, constraints: ExtentConstraint[]): void {
  if (!constraints.length) return;
  const { width, height, inside } = s;
  const factors = constraints.map((c) => {
    const lines = c.axis === 'rows' ? height : width;
    const len = c.axis === 'rows' ? width : height;
    const k = new Float32Array(lines).fill(NaN);
    for (let line = 0; line < lines; line++) {
      let maxT = 0;
      for (let pos = 0; pos < len; pos++) {
        const i = c.axis === 'rows' ? line * width + pos : pos * width + line;
        if (inside[i]) maxT = Math.max(maxT, hF[i] + hB[i]);
      }
      const target = c.values[line];
      if (maxT > 1e-3 && target > 0) k[line] = Math.log(clamp(target / maxT, 0.15, 6));
    }
    fillNaN(k);
    return { axis: c.axis, logK: blurBuffer(k, lines, 1, 2) };
  });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!inside[i]) continue;
      let logSum = 0;
      for (const f of factors) logSum += f.axis === 'rows' ? f.logK[y] : f.logK[x];
      const k = Math.exp(logSum / factors.length);
      hF[i] *= k;
      hB[i] *= k;
    }
  }
}

function fillNaN(a: Float32Array): void {
  let last = NaN;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i])) a[i] = last;
    else last = a[i];
  }
  last = NaN;
  for (let i = a.length - 1; i >= 0; i--) {
    if (Number.isNaN(a[i])) a[i] = last;
    else last = a[i];
  }
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = 0;
}

/**
 * Front-to-back extent per front line, in front grid pixels. `frontSpans` and
 * `refSpans` describe the object along the axis both photos share (rows for a
 * side view, columns for a top view); each reference line's span width is the
 * object's depth there. Lengths are normalised by the bounding-box extent along
 * the shared axis, so photos taken at any zoom line up.
 */
export function extentFromReference(frontSpans: Spans, refSpans: Spans): Float32Array {
  const out = new Float32Array(frontSpans.count);
  const scale = spanExtent(frontSpans) / spanExtent(refSpans);
  for (let line = frontSpans.first; line <= frontSpans.last; line++) {
    const t = spanT(frontSpans, line);
    const [a, b] = spanAt(refSpans, spanLineAt(refSpans, t));
    out[line] = Math.max(0, b - a + 1) * scale;
  }
  return out;
}

/**
 * Sub-pixel outline: for every rim pixel of the grid, find where the
 * full-resolution cut-out crosses 50% alpha along the outward normal and
 * return the (dx, dy) shift that puts the vertex on that crossing, plus the
 * outward outline direction. Removes the staircase a coarse mesh grid would
 * otherwise give the silhouette.
 */
export function rimOffsets(s: Silhouette, mask: ByteField): { offset: Float32Array; dir: Float32Array; snapped: Uint8Array } {
  const { width: W, height: H, inside } = s;
  const out = new Float32Array(W * H * 2);
  const dirs = new Float32Array(W * H * 2);
  const snapped = new Uint8Array(W * H);
  // Rim = inside pixels with a 4-neighbour outside (the mesh's boundary vertices).
  const isOut = (i: number, j: number) => i < 0 || j < 0 || i >= W || j >= H || !inside[j * W + i];
  const alpha: FloatField = { width: mask.width, height: mask.height, data: Float32Array.from(mask.data, (v) => v / 255) };
  const sx = mask.width / W;
  const sy = mask.height / H;
  const a = (x: number, y: number) => sampleFloat(alpha, x * sx - 0.5, y * sy - 0.5);
  const D = distanceTransform(inside, W, H).data;
  const d = (i: number, j: number) => (isOut(i, j) ? 0 : D[j * W + i]);
  const step = 1 / 16;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p] || !(isOut(i - 1, j) || isOut(i + 1, j) || isOut(i, j - 1) || isOut(i, j + 1))) continue;
      let nx = -(d(i + 1, j) - d(i - 1, j));
      let ny = -(d(i, j + 1) - d(i, j - 1));
      const len = Math.hypot(nx, ny);
      if (len < 1e-3) continue;
      nx /= len;
      ny /= len;
      dirs[p * 2] = nx;
      dirs[p * 2 + 1] = ny;
      const cx = i + 0.5;
      const cy = j + 0.5;
      let prevT = -0.5;
      let prevA = a(cx + nx * prevT, cy + ny * prevT);
      if (prevA < 0.5) continue;
      for (let t = prevT + step; t <= 1.0001; t += step) {
        const A = a(cx + nx * t, cy + ny * t);
        if (A < 0.5) {
          const tc = clamp(prevT + ((prevA - 0.5) / Math.max(1e-6, prevA - A)) * step, -0.45, 0.75);
          out[p * 2] = nx * tc;
          out[p * 2 + 1] = ny * tc;
          snapped[p] = 1;
          break;
        }
        prevT = t;
        prevA = A;
      }
    }
  }
  return { offset: out, dir: dirs, snapped };
}

/**
 * The rim profile is steep, so a mesh ring that is 1.0 px from the outline in
 * one row and 1.7 px in the next gives very different triangles: visible
 * ridges along the seam. Move the second and third rings of grid vertices
 * along the distance gradient so they sit exactly 1 and 2 px from the
 * outline, like the outermost ring sits exactly on it.
 *
 * Returns per-pixel offsets (to add to the rim offsets) and the vertices'
 * new distance to the outline.
 */
export function ringOffsets(s: Silhouette, signedDist: Float32Array): { offset: Float32Array; dist: Float32Array } {
  const { width: W, height: H, inside } = s;
  const offset = new Float32Array(W * H * 2);
  const dist = new Float32Array(s.dist);
  // Ring index by 4-connected peeling from the outside.
  const ring = new Int32Array(W * H).fill(-1);
  let frontier: number[] = [];
  const isOut = (i: number, j: number) => i < 0 || j < 0 || i >= W || j >= H || !inside[j * W + i];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (inside[p] && (isOut(i - 1, j) || isOut(i + 1, j) || isOut(i, j - 1) || isOut(i, j + 1))) {
        ring[p] = 0;
        frontier.push(p);
      }
    }
  }
  for (let k = 1; k <= 2; k++) {
    const next: number[] = [];
    for (const p of frontier) {
      const i = p % W;
      const j = (p - i) / W;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (isOut(ii, jj)) continue;
        const q = jj * W + ii;
        if (ring[q] === -1) {
          ring[q] = k;
          next.push(q);
        }
      }
    }
    frontier = next;
  }
  const sd = (i: number, j: number) => signedDist[clamp(j, 0, H - 1) * W + clamp(i, 0, W - 1)];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      const k = ring[p];
      if (k < 1) continue;
      let gi = (sd(i + 1, j) - sd(i - 1, j)) / 2;
      let gj = (sd(i, j + 1) - sd(i, j - 1)) / 2;
      const gl = Math.hypot(gi, gj);
      if (gl < 0.3) continue;
      gi /= gl;
      gj /= gl;
      const move = clamp(k - signedDist[p], -0.8, 0.8);
      offset[p * 2] = gi * move;
      offset[p * 2 + 1] = gj * move;
      dist[p] = Math.max(0.05, signedDist[p] + move);
    }
  }
  for (let p = 0; p < W * H; p++) if (ring[p] === 0) dist[p] = 0.02;
  return { offset, dist };
}

/** Circle-profile height ratio for moving a vertex from distance `from` to `to` (radius R). */
export function profileRatio(from: number, to: number, R: number): number {
  const f = (d: number) => Math.sqrt(Math.max(1e-6, d * (2 * R - d)));
  return clamp(f(to) / f(from), 0.3, 3);
}
