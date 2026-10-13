import { imageToLab, rgbToLab } from './color';
import { distanceTransform } from './distance';
import { createByte, resizeByte, resizeRGBA } from './imageops';
import type { ByteField, RGBAImage } from './types';

export interface SegmentOptions {
  /** Colour distance (CIE76 ΔE) still treated as background. */
  tolerance: number;
  /** Also remove background visible through enclosed holes (mug handles, rings ...). */
  enclosedHoles: boolean;
  /** Working resolution (longest side). */
  workSize: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = { tolerance: 16, enclosedHoles: true, workSize: 512 };

export interface SegmentResult {
  mask: ByteField;
  /** 0..1: how much of the frame border matched a background colour model. */
  confidence: number;
  method: 'alpha' | 'color-key' | 'none';
}

/** True when the image carries a usable alpha cut-out (e.g. a PNG product shot). */
export function hasUsefulAlpha(img: RGBAImage): boolean {
  const n = img.width * img.height;
  let transparent = 0;
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3];
    if (a < 16) transparent++;
    else if (a > 240) opaque++;
  }
  return transparent > n * 0.01 && opaque > n * 0.01;
}

export function alphaMask(img: RGBAImage): ByteField {
  const out = createByte(img.width, img.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = img.data[i * 4 + 3];
  return out;
}

function kmeans(samples: Float32Array, count: number, k: number, iters = 12): { centers: Float32Array; sizes: number[] } {
  const centers = new Float32Array(k * 3);
  // Deterministic farthest-point initialisation.
  centers.set(samples.subarray(0, 3), 0);
  const minDist = new Float32Array(count).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < count; i++) {
      const d = dist2(samples, i * 3, centers, (c - 1) * 3);
      if (d < minDist[i]) minDist[i] = d;
      if (minDist[i] > bestD) {
        bestD = minDist[i];
        best = i;
      }
    }
    centers.set(samples.subarray(best * 3, best * 3 + 3), c * 3);
  }
  const assign = new Int32Array(count);
  const sizes = new Array<number>(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const acc = new Float64Array(k * 3);
    sizes.fill(0);
    for (let i = 0; i < count; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(samples, i * 3, centers, c * 3);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
      sizes[best]++;
      acc[best * 3] += samples[i * 3];
      acc[best * 3 + 1] += samples[i * 3 + 1];
      acc[best * 3 + 2] += samples[i * 3 + 2];
    }
    for (let c = 0; c < k; c++) {
      if (sizes[c] === 0) continue;
      centers[c * 3] = acc[c * 3] / sizes[c];
      centers[c * 3 + 1] = acc[c * 3 + 1] / sizes[c];
      centers[c * 3 + 2] = acc[c * 3 + 2] / sizes[c];
    }
  }
  return { centers, sizes };
}

function dist2(a: Float32Array, ai: number, b: Float32Array, bi: number): number {
  const d0 = a[ai] - b[bi];
  const d1 = a[ai + 1] - b[bi + 1];
  const d2 = a[ai + 2] - b[bi + 2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

/** Label 4-connected components of pixels where `on[i]` is set. Returns labels (0 = none) and sizes. */
export function connectedComponents(on: Uint8Array, width: number, height: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(width * height);
  const sizes = [0];
  const stack = new Int32Array(width * height);
  let next = 1;
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || labels[s]) continue;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = next;
    let size = 0;
    while (sp > 0) {
      const i = stack[--sp];
      size++;
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0 && on[i - 1] && !labels[i - 1]) { labels[i - 1] = next; stack[sp++] = i - 1; }
      if (x < width - 1 && on[i + 1] && !labels[i + 1]) { labels[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && on[i - width] && !labels[i - width]) { labels[i - width] = next; stack[sp++] = i - width; }
      if (y < height - 1 && on[i + width] && !labels[i + width]) { labels[i + width] = next; stack[sp++] = i + width; }
    }
    sizes.push(size);
    next++;
  }
  return { labels, sizes };
}

function morph(on: Uint8Array, width: number, height: number, erode: boolean): Uint8Array {
  const out = new Uint8Array(on.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = on[i];
      const nb = [x > 0 ? on[i - 1] : 0, x < width - 1 ? on[i + 1] : 0, y > 0 ? on[i - width] : 0, y < height - 1 ? on[i + width] : 0];
      if (erode) {
        for (const n of nb) if (!n) v = 0;
      } else {
        for (const n of nb) if (n) v = 1;
      }
      out[i] = v;
    }
  }
  return out;
}

/**
 * Remove specks, keep the significant object components and close small holes.
 * Works on a binary map (1 = object).
 */
export function cleanupMask(on: Uint8Array, width: number, height: number, keepHoles: Uint8Array | null, minHoleArea = 0): Uint8Array {
  let m = morph(morph(on, width, height, true), width, height, false);
  // Keep components that are a meaningful fraction of the biggest one (pairs of shoes, etc.).
  const { labels, sizes } = connectedComponents(m, width, height);
  let biggest = 0;
  for (let i = 1; i < sizes.length; i++) biggest = Math.max(biggest, sizes[i]);
  const keep = sizes.map((s, i) => i > 0 && s >= Math.max(8, biggest * 0.05));
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = keep[labels[i]] ? 1 : 0;
  // Fill holes that are not explicitly known background.
  const holesOn = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) holesOn[i] = out[i] ? 0 : 1;
  const holes = connectedComponents(holesOn, width, height);
  const touchesBorder = new Uint8Array(holes.sizes.length);
  for (let x = 0; x < width; x++) {
    touchesBorder[holes.labels[x]] = 1;
    touchesBorder[holes.labels[(height - 1) * width + x]] = 1;
  }
  for (let y = 0; y < height; y++) {
    touchesBorder[holes.labels[y * width]] = 1;
    touchesBorder[holes.labels[y * width + width - 1]] = 1;
  }
  const knownHole = new Uint8Array(holes.sizes.length);
  if (keepHoles) {
    for (let i = 0; i < out.length; i++) if (keepHoles[i] && holes.labels[i]) knownHole[holes.labels[i]] = 1;
  }
  for (let i = 0; i < out.length; i++) {
    const l = holes.labels[i];
    if (l && !touchesBorder[l] && (!knownHole[l] || holes.sizes[l] < minHoleArea)) out[i] = 1;
  }
  m = out;
  return m;
}

/**
 * Classical background removal for photos on a fairly uniform backdrop:
 * model the backdrop from the frame border (k-means in Lab), flood it in from
 * the edges, optionally remove backdrop seen through enclosed holes, then
 * clean up. Used when no AI matting model is available.
 */
export function segmentByColor(img: RGBAImage, opts: SegmentOptions = DEFAULT_SEGMENT_OPTIONS): SegmentResult {
  const scale = Math.min(1, opts.workSize / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const small = resizeRGBA(img, w, h);
  const lab = imageToLab(small);

  const borderIdx: number[] = [];
  for (let x = 0; x < w; x++) {
    borderIdx.push(x, w + x, (h - 1) * w + x, (h - 2) * w + x);
  }
  for (let y = 0; y < h; y++) {
    borderIdx.push(y * w, y * w + 1, y * w + w - 1, y * w + w - 2);
  }
  const samples = new Float32Array(borderIdx.length * 3);
  borderIdx.forEach((p, i) => samples.set(lab.subarray(p * 3, p * 3 + 3), i * 3));
  const k = 4;
  const { centers, sizes } = kmeans(samples, borderIdx.length, k);
  const models: number[] = [];
  for (let c = 0; c < k; c++) if (sizes[c] >= borderIdx.length * 0.08) models.push(c);

  const tol2 = opts.tolerance * opts.tolerance;
  const bgDist2 = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let best = Infinity;
    for (const c of models) best = Math.min(best, dist2(lab, i * 3, centers, c * 3));
    bgDist2[i] = best;
  }

  let matched = 0;
  for (const p of borderIdx) if (bgDist2[p] <= tol2) matched++;
  const confidence = matched / borderIdx.length;

  // Flood fill from the border through backdrop-coloured, smoothly varying pixels.
  const bg = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (const p of borderIdx) {
    if (!bg[p] && bgDist2[p] <= tol2) {
      bg[p] = 1;
      stack[sp++] = p;
    }
  }
  const stepTol2 = tol2 * 0.6;
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i - x) / w;
    const nbs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nbs) {
      if (j < 0 || bg[j]) continue;
      if (bgDist2[j] <= tol2 && dist2(lab, i * 3, lab, j * 3) <= stepTol2) {
        bg[j] = 1;
        stack[sp++] = j;
      }
    }
  }

  let holes: Uint8Array | null = null;
  if (opts.enclosedHoles) {
    const strict2 = tol2 * 0.5;
    const cand = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) cand[i] = !bg[i] && bgDist2[i] <= strict2 ? 1 : 0;
    const cc = connectedComponents(cand, w, h);
    // Large enough that specular highlights on glossy objects are not mistaken for holes.
    const minArea = w * h * 0.005;
    holes = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const l = cc.labels[i];
      if (l && cc.sizes[l] >= minArea) {
        holes[i] = 1;
        bg[i] = 1;
      }
    }
  }

  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) fg[i] = bg[i] ? 0 : 1;
  const cleaned = cleanupMask(fg, w, h, holes);
  let count = 0;
  const small8 = createByte(w, h);
  for (let i = 0; i < w * h; i++) {
    small8.data[i] = cleaned[i] ? 255 : 0;
    count += cleaned[i];
  }
  if (count === 0 || models.length === 0) {
    const full = createByte(img.width, img.height);
    full.data.fill(255);
    return { mask: full, confidence: 0, method: 'none' };
  }
  const full = resizeByte(small8, img.width, img.height);
  refineEdges(img, full, models.map((c) => [centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]]), opts.tolerance);
  return { mask: full, confidence, method: 'color-key' };
}

/**
 * The mask was found at a reduced resolution, so its outline can sit a pixel
 * or two inside the backdrop. Re-decide every pixel within ~2.5 px of the
 * outline at full resolution from its own colour: backdrop-coloured pixels
 * become transparent, mixed (anti-aliased) pixels get partial alpha.
 */
function refineEdges(img: RGBAImage, mask: ByteField, models: number[][], tolerance: number): void {
  const { width, height } = img;
  const n = width * height;
  const on = new Uint8Array(n);
  const off = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    on[i] = mask.data[i] >= 128 ? 1 : 0;
    off[i] = 1 - on[i];
  }
  const dIn = distanceTransform(on, width, height).data;
  const dOut = distanceTransform(off, width, height).data;
  const lab = [0, 0, 0];
  const lo = tolerance * 0.55;
  const hi = tolerance * 1.1;
  for (let i = 0; i < n; i++) {
    const nearEdge = on[i] ? dIn[i] <= 2.5 : dOut[i] <= 1.5;
    if (!nearEdge) continue;
    rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2], lab);
    let best = Infinity;
    for (const m of models) best = Math.min(best, Math.hypot(lab[0] - m[0], lab[1] - m[1], lab[2] - m[2]));
    const a = Math.max(0, Math.min(1, (best - lo) / (hi - lo)));
    mask.data[i] = on[i] ? Math.round(Math.min(mask.data[i], a * 255)) : Math.round(Math.max(mask.data[i], Math.min(a, 0.45) * 255));
  }
}

/** Threshold a soft mask into a 0/1 map. */
export function binarize(mask: ByteField, threshold = 128): Uint8Array {
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = mask.data[i] >= threshold ? 1 : 0;
  return out;
}

/** Keep only the largest components of an AI-produced matte and fill small pin holes. */
export function refineMatte(mask: ByteField): ByteField {
  const on = binarize(mask);
  const cleaned = cleanupMask(on, mask.width, mask.height, binarize(invert(mask), 200), mask.width * mask.height * 0.0005);
  const out = createByte(mask.width, mask.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = cleaned[i] ? Math.max(mask.data[i], on[i] ? 0 : 160) : Math.min(mask.data[i], 100);
  return out;
}

function invert(mask: ByteField): ByteField {
  const out = createByte(mask.width, mask.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = 255 - mask.data[i];
  return out;
}
