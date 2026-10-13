import { colSpans, rowSpans, spanAt, spanLineAt, spanT, type Spans } from './align';
import { bleedRGBA, blurBuffer, clamp, createRGBA, pushPull, resizeByte, resizeRGBA, sampleFloat, sampleRGBA } from './imageops';
import { distanceTransform } from './distance';
import type { AtlasLayout } from './mesh';
import { backWarpCoord } from './shape';
import type { ByteField, RGBAImage } from './types';

/** A reference photo cropped to its object, flipped as requested, colour-matched and bled. */
export interface TextureRef {
  image: RGBAImage;
  rows: Spans;
  cols: Spans;
}

export interface TextureInput {
  frontImage: RGBAImage;
  frontMask: ByteField;
  gridW: number;
  gridH: number;
  inside: Uint8Array;
  zF: Float32Array;
  zB: Float32Array;
  layout: AtlasLayout;
  back?: TextureRef;
  left?: TextureRef;
  right?: TextureRef;
  top?: TextureRef;
  backTexture: 'reference' | 'mirror' | 'tone';
  sideBlend: number;
  /** Unit normals per grid pixel (3 floats) of the front and back layers, as used by the mesh. */
  normalF?: Float32Array;
  normalB?: Float32Array;
}

const ATLAS_PAD = 16;

/** Atlas holding the front photo on the left and the back texture on the right. */
export function atlasLayout(cropW: number, cropH: number, maxSize: number): AtlasLayout {
  const s = Math.min(1, (maxSize - ATLAS_PAD) / (2 * cropW), maxSize / cropH);
  const w = Math.max(4, Math.floor(cropW * s));
  const h = Math.max(4, Math.floor(cropH * s));
  return {
    width: w * 2 + ATLAS_PAD,
    height: h,
    front: { x: 0, y: 0, w, h },
    back: { x: w + ATLAS_PAD, y: 0, w, h },
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

interface NormalField {
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
}

/**
 * Per-grid-pixel unit normals of a height layer. `sign` = +1 for the front
 * surface (facing +z), -1 for the back. One-sided differences at the rim,
 * values outside the silhouette extrapolated so bilinear lookups stay sane.
 */
function normalField(z: Float32Array, inside: Uint8Array, W: number, H: number, sign: 1 | -1): NormalField {
  const n = W * H;
  const vals = new Float32Array(n * 3);
  const wts = new Float32Array(n);
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < W && j < H && inside[j * W + i] ? z[j * W + i] : NaN);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p]) continue;
      const c = z[p];
      const l = at(i - 1, j), r = at(i + 1, j), u = at(i, j - 1), d = at(i, j + 1);
      const dzdi = !Number.isNaN(l) && !Number.isNaN(r) ? (r - l) / 2 : !Number.isNaN(r) ? r - c : !Number.isNaN(l) ? c - l : 0;
      const dzdj = !Number.isNaN(u) && !Number.isNaN(d) ? (d - u) / 2 : !Number.isNaN(d) ? d - c : !Number.isNaN(u) ? c - u : 0;
      // World: x = i, y = -j. Front normal ∝ (-dz/dx, -dz/dy, 1); back is mirrored in z.
      let nx = -sign * dzdi;
      let ny = sign * dzdj;
      let nz: number = sign;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      vals[p * 3] = nx;
      vals[p * 3 + 1] = ny;
      vals[p * 3 + 2] = nz;
      wts[p] = 1;
    }
  }
  const filled = pushPull(vals, wts, W, H, 3);
  const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    nx[p] = filled[p * 3];
    ny[p] = filled[p * 3 + 1];
    nz[p] = filled[p * 3 + 2];
  }
  return { nx, ny, nz };
}

/** Split interleaved per-pixel normals and extrapolate them outside the silhouette. */
function toNormalField(interleaved: Float32Array, inside: Uint8Array, W: number, H: number): NormalField {
  const n = W * H;
  const wts = new Float32Array(n);
  for (let p = 0; p < n; p++) wts[p] = inside[p] ? 1 : 0;
  const filled = pushPull(interleaved, wts, W, H, 3);
  const nx = new Float32Array(n), ny = new Float32Array(n), nz = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    nx[p] = filled[p * 3];
    ny[p] = filled[p * 3 + 1];
    nz[p] = filled[p * 3 + 2];
  }
  return { nx, ny, nz };
}

/** Front-to-back depth range of every grid row and column, used to place points in side/top photos. */
function extents(zF: Float32Array, zB: Float32Array, inside: Uint8Array, W: number, H: number) {
  const rowMin = new Float32Array(H).fill(Infinity), rowMax = new Float32Array(H).fill(-Infinity);
  const colMin = new Float32Array(W).fill(Infinity), colMax = new Float32Array(W).fill(-Infinity);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p]) continue;
      rowMin[j] = Math.min(rowMin[j], zB[p]);
      rowMax[j] = Math.max(rowMax[j], zF[p]);
      colMin[i] = Math.min(colMin[i], zB[p]);
      colMax[i] = Math.max(colMax[i], zF[p]);
    }
  }
  const fix = (lo: Float32Array, hi: Float32Array) => {
    for (let k = 0; k < lo.length; k++) {
      if (!Number.isFinite(lo[k])) {
        lo[k] = 0;
        hi[k] = 1;
      }
    }
  };
  fix(rowMin, rowMax);
  fix(colMin, colMax);
  return { rowMin, rowMax, colMin, colMax };
}

function lerpArr(a: Float32Array, x: number): number {
  const c = clamp(x, 0, a.length - 1);
  const i = Math.floor(c);
  const j = Math.min(i + 1, a.length - 1);
  return a[i] + (a[j] - a[i]) * (c - i);
}

function spansOfMask(mask: ByteField): { rows: Spans; cols: Spans } | null {
  const on = new Uint8Array(mask.data.length);
  for (let i = 0; i < on.length; i++) on[i] = mask.data[i] >= 128 ? 1 : 0;
  const rows = rowSpans(on, mask.width, mask.height);
  const cols = colSpans(on, mask.width, mask.height);
  return rows && cols ? { rows, cols } : null;
}

/** Heavily blurred, detail-free version of the front colours ("what colour is the back probably?"). */
function toneTexture(front: RGBAImage, mask: ByteField): RGBAImage {
  const s = 64 / Math.max(front.width, front.height);
  const w = Math.max(4, Math.round(front.width * s));
  const h = Math.max(4, Math.round(front.height * s));
  const small = resizeRGBA(front, w, h);
  const m = resizeByte(mask, w, h);
  const vals = new Float32Array(w * h * 3);
  const wts = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = m.data[i] / 255;
    wts[i] = a;
    for (let c = 0; c < 3; c++) vals[i * 3 + c] = small.data[i * 4 + c] * a;
  }
  const blurredW = blurBuffer(wts, w, h, 4);
  const out = createRGBA(w, h);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ch[i] = vals[i * 3 + c];
    const b = blurBuffer(ch, w, h, 4);
    for (let i = 0; i < w * h; i++) out.data[i * 4 + c] = blurredW[i] > 1e-3 ? b[i] / blurredW[i] : 128;
  }
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = 255;
  return resizeRGBA(out, front.width, front.height);
}

/**
 * Bakes the texture atlas. The front half is the user's photo itself
 * (only the anti-aliased rim is cleaned), so the model matches the photo
 * pixel for pixel from the camera's viewpoint. The back half comes from a
 * reference photo of the back when available. Side/top references replace
 * texels that the photo only sees at a grazing angle.
 */
export function bakeAtlas(t: TextureInput): RGBAImage {
  const { layout, gridW: W, gridH: H, inside } = t;
  const TW = layout.front.w;
  const TH = layout.front.h;
  const tex = resizeRGBA(t.frontImage, TW, TH);
  const mask = resizeByte(t.frontMask, TW, TH);
  const n = TW * TH;
  let inCount = 0;
  let coreCount = 0;
  for (let i = 0; i < n; i++) {
    if (mask.data[i] >= 128) inCount++;
    if (mask.data[i] >= 230) coreCount++;
  }
  const coreThreshold = coreCount >= inCount * 0.6 ? 230 : 128;
  // Rim pixels of a photo mix object and backdrop colours; the steep sides of the model
  // stretch them, so rebuild a thin rim from interior colours instead.
  const texInside = new Uint8Array(n);
  for (let i = 0; i < n; i++) texInside[i] = mask.data[i] >= 128 ? 1 : 0;
  const edgeDist = distanceTransform(texInside, TW, TH).data;
  const rim = Math.max(1.5, Math.max(TW, TH) / 700);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = mask.data[i] >= coreThreshold && edgeDist[i] > rim ? 1 : 0;
  const front = bleedRGBA(tex, valid);

  const spans = spansOfMask(mask);
  let back: RGBAImage;
  if (t.backTexture === 'reference' && t.back && spans) {
    back = createRGBA(TW, TH);
    const px = new Float32Array(4);
    const warp = { frontRows: spans.rows, refRows: t.back.rows };
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        const [rx, ry] = backWarpCoord(warp, x, y);
        sampleRGBA(t.back.image, rx, ry, px);
        const o = (y * TW + x) * 4;
        back.data[o] = px[0];
        back.data[o + 1] = px[1];
        back.data[o + 2] = px[2];
        back.data[o + 3] = 255;
      }
    }
  } else if (t.backTexture === 'mirror') {
    back = { width: TW, height: TH, data: new Uint8ClampedArray(front.data) };
  } else {
    back = toneTexture(front, mask);
  }

  const nfFront = t.normalF ? toNormalField(t.normalF, inside, W, H) : normalField(t.zF, inside, W, H, 1);
  const nfBack = t.normalB ? toNormalField(t.normalB, inside, W, H) : normalField(t.zB, inside, W, H, -1);
  harmoniseSeam(front, back, nfFront, nfBack, W, H);
  // The last couple of grid pixels before the outline become a near-vertical strip
  // on the model; smooth them along the outline so per-row jitter of the cut-out
  // does not turn into streaks (colours across the edge, e.g. dark outlines, stay).
  const gridPx = TW / W;
  const zone = Math.max(2, 2.5 * gridPx);
  tangentialRimBlur(front, edgeDist, zone, Math.max(1, gridPx));
  tangentialRimBlur(back, edgeDist, zone, Math.max(1, gridPx));

  const sides: { ref: TextureRef; kind: 'left' | 'right' | 'top' }[] = [];
  if (t.left) sides.push({ ref: t.left, kind: 'left' });
  if (t.right) sides.push({ ref: t.right, kind: 'right' });
  if (t.top) sides.push({ ref: t.top, kind: 'top' });
  if (sides.length && t.sideBlend > 0 && spans) {
    const ext = extents(t.zF, t.zB, inside, W, H);
    const fields = [
      { img: front, z: t.zF, nf: nfFront, real: true },
      { img: back, z: t.zB, nf: nfBack, real: t.backTexture === 'reference' },
    ];
    const px = new Float32Array(4);
    for (const f of fields) {
      const lo = f.real ? 0.55 : 0.25;
      const hi = f.real ? 0.92 : 0.7;
      const zField = { width: W, height: H, data: f.z };
      const nxF = { width: W, height: H, data: f.nf.nx };
      const nyF = { width: W, height: H, data: f.nf.ny };
      const nzF = { width: W, height: H, data: f.nf.nz };
      for (let y = 0; y < TH; y++) {
        const gj = ((y + 0.5) / TH) * H - 0.5;
        for (let x = 0; x < TW; x++) {
          const i = y * TW + x;
          if (mask.data[i] < 64) continue;
          const gi = ((x + 0.5) / TW) * W - 0.5;
          const nx = sampleFloat(nxF, gi, gj);
          const ny = sampleFloat(nyF, gi, gj);
          const nz = sampleFloat(nzF, gi, gj);
          let wSum = Math.max(0, Math.abs(nz)) ** 2 + 0.02;
          const o = i * 4;
          let r = f.img.data[o] * wSum, g = f.img.data[o + 1] * wSum, b = f.img.data[o + 2] * wSum;
          let used = false;
          for (const s of sides) {
            const facing = s.kind === 'right' ? nx : s.kind === 'left' ? -nx : ny;
            const w = t.sideBlend * smoothstep(lo, hi, facing);
            if (w <= 0) continue;
            const z = sampleFloat(zField, gi, gj);
            let sx: number, sy: number;
            if (s.kind === 'top') {
              const tt = spanT(spans.cols, x);
              sx = spanLineAt(s.ref.cols, clamp(tt, 0, 1));
              const [top, bottom] = spanAt(s.ref.cols, sx);
              const zMin = lerpArr(ext.colMin, gi), zMax = lerpArr(ext.colMax, gi);
              const v = zMax > zMin ? (z - zMin) / (zMax - zMin) : 0.5;
              sy = top + clamp(v, 0, 1) * (bottom - top);
            } else {
              const tt = spanT(spans.rows, y);
              sy = spanLineAt(s.ref.rows, clamp(tt, 0, 1));
              const [l, rr] = spanAt(s.ref.rows, sy);
              const zMin = lerpArr(ext.rowMin, gj), zMax = lerpArr(ext.rowMax, gj);
              let u = zMax > zMin ? (z - zMin) / (zMax - zMin) : 0.5;
              // Seen from the right the object's front is on the image's left, and vice versa.
              if (s.kind === 'right') u = 1 - u;
              sx = l + clamp(u, 0, 1) * (rr - l);
            }
            sampleRGBA(s.ref.image, sx, sy, px);
            r += px[0] * w;
            g += px[1] * w;
            b += px[2] * w;
            wSum += w;
            used = true;
          }
          if (!used) continue;
          f.img.data[o] = r / wSum;
          f.img.data[o + 1] = g / wSum;
          f.img.data[o + 2] = b / wSum;
        }
      }
    }
  }

  // Fill everything outside the silhouette so mip-mapping never pulls in background.
  const inMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) inMask[i] = mask.data[i] >= 64 ? 1 : 0;
  const backFilled = bleedRGBA(back, inMask);

  const atlas = createRGBA(layout.width, layout.height);
  const blit = (src: RGBAImage, ox: number) => {
    for (let y = 0; y < TH; y++) atlas.data.set(src.data.subarray(y * TW * 4, (y + 1) * TW * 4), (y * layout.width + ox) * 4);
  };
  blit(front, layout.front.x);
  blit(backFilled, layout.back.x);
  // Gutter: extend the edge columns of both halves.
  for (let y = 0; y < TH; y++) {
    for (let x = TW; x < layout.back.x; x++) {
      const srcX = x - TW < (layout.back.x - TW) / 2 ? TW - 1 : layout.back.x;
      const s = (y * layout.width + srcX) * 4;
      const d = (y * layout.width + x) * 4;
      atlas.data[d] = atlas.data[s];
      atlas.data[d + 1] = atlas.data[s + 1];
      atlas.data[d + 2] = atlas.data[s + 2];
      atlas.data[d + 3] = 255;
    }
  }
  return atlas;
}

/** Blur texels within `zone` px of the outline along the outline's tangent only. */
function tangentialRimBlur(img: RGBAImage, edgeDist: Float32Array, zone: number, sigma: number): void {
  const { width: TW, height: TH } = img;
  const d = blurBuffer(edgeDist, TW, TH, 1.5);
  const field = { width: TW, height: TH, data: d };
  const src = new Uint8ClampedArray(img.data);
  const srcImg: RGBAImage = { width: TW, height: TH, data: src };
  const px = new Float32Array(4);
  const taps = [-3, -2, -1, 0, 1, 2, 3];
  const weights = taps.map((t) => Math.exp(-(t * t) / 4.5));
  for (let y = 1; y < TH - 1; y++) {
    for (let x = 1; x < TW - 1; x++) {
      const e = edgeDist[y * TW + x];
      if (e <= 0 || e > zone) continue;
      const gx = sampleFloat(field, x + 1, y) - sampleFloat(field, x - 1, y);
      const gy = sampleFloat(field, x, y + 1) - sampleFloat(field, x, y - 1);
      const gl = Math.hypot(gx, gy);
      if (gl < 1e-3) continue;
      const tx = -gy / gl;
      const ty = gx / gl;
      let r = 0, g = 0, b = 0, ws = 0;
      for (let k = 0; k < taps.length; k++) {
        const off = (taps[k] * sigma) / 1.5;
        sampleRGBA(srcImg, x + tx * off, y + ty * off, px);
        r += px[0] * weights[k];
        g += px[1] * weights[k];
        b += px[2] * weights[k];
        ws += weights[k];
      }
      const w = 1 - smoothstep(zone * 0.5, zone, e);
      const o = (y * TW + x) * 4;
      img.data[o] += (r / ws - img.data[o]) * w;
      img.data[o + 1] += (g / ws - img.data[o + 1]) * w;
      img.data[o + 2] += (b / ws - img.data[o + 2]) * w;
    }
  }
}

/** Low-frequency copy of a texture (blurred at reduced resolution, then upsampled). */
function softCopy(img: RGBAImage): RGBAImage {
  const s = 192 / Math.max(img.width, img.height);
  if (s >= 1) return img;
  const w = Math.max(4, Math.round(img.width * s));
  const h = Math.max(4, Math.round(img.height * s));
  const small = resizeRGBA(img, w, h);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) ch[i] = small.data[i * 4 + c];
    const b = blurBuffer(ch, w, h, 1.5);
    for (let i = 0; i < w * h; i++) small.data[i * 4 + c] = b[i];
  }
  return resizeRGBA(small, img.width, img.height);
}

/**
 * Where the surface turns away from the camera the photo has almost no pixels,
 * so the outermost colours get stretched into streaks, and front and back
 * textures meet with a hard seam. Fade both halves towards the same smooth
 * average there. Only texels the camera sees at a grazing angle (a few pixels
 * at the outline) are touched.
 */
function harmoniseSeam(front: RGBAImage, back: RGBAImage, nfF: NormalField, nfB: NormalField, W: number, H: number): void {
  const TW = front.width;
  const TH = front.height;
  const softF = softCopy(front);
  const softB = softCopy(back);
  const fz = { width: W, height: H, data: nfF.nz };
  const bz = { width: W, height: H, data: nfB.nz };
  for (let y = 0; y < TH; y++) {
    const gj = ((y + 0.5) / TH) * H - 0.5;
    for (let x = 0; x < TW; x++) {
      const gi = ((x + 0.5) / TW) * W - 0.5;
      const wf = 1 - smoothstep(0.03, 0.2, Math.abs(sampleFloat(fz, gi, gj)));
      const wb = 1 - smoothstep(0.03, 0.2, Math.abs(sampleFloat(bz, gi, gj)));
      if (wf <= 0 && wb <= 0) continue;
      const o = (y * TW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const avg = (softF.data[o + c] + softB.data[o + c]) / 2;
        front.data[o + c] += (avg - front.data[o + c]) * wf;
        back.data[o + c] += (avg - back.data[o + c]) * wb;
      }
    }
  }
}

/** Fill a reference photo's background with extrapolated object colours, so warps that land just outside its silhouette stay on-object. */
export function bleedReference(img: RGBAImage, mask: ByteField): RGBAImage {
  const valid = new Uint8Array(mask.data.length);
  for (let i = 0; i < valid.length; i++) valid[i] = mask.data[i] >= 200 ? 1 : 0;
  return bleedRGBA(img, valid);
}

/** Row and column spans of a mask (>= 128). */
export function maskSpans(mask: ByteField): { rows: Spans; cols: Spans } | null {
  return spansOfMask(mask);
}
