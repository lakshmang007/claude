import { colSpans, rowSpans, spanAt, spanLineAt, spanT, type Spans } from './align';
import { imageToLab, rgbToLab } from './color';
import { bleedRGBA, blurBuffer, clamp, createRGBA, pushPull, resizeByte, resizeFloat, resizeRGBA, sampleFloat, sampleRGBA } from './imageops';
import { distanceTransform } from './distance';
import type { AtlasLayout } from './mesh';
import { backWarpCoord } from './shape';
import type { ByteField, FloatField, RGBAImage } from './types';

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

/**
 * Seam fade: texels whose |nz| is below SEAM_HI move towards the interior
 * colour, fully below SEAM_LO. Within RIM_PX of the outline, where the photo
 * mixes in backdrop and Fresnel tint, the ramp reaches up to SEAM_HI_RIM.
 */
const SEAM_LO = 0.03;
const SEAM_HI = 0.2;
const SEAM_HI_RIM = 0.4;
const RIM_PX = 5;
/**
 * Bright streaks (rim lights, reflections) that the photo only shows at a
 * grazing angle get stretched over the side of the model. Texels whose |nz|
 * is below the HIGHLIGHT_NZ ramp, that are HIGHLIGHT_EXCESS brighter
 * (luminance) than the nearby interior and that are near-white (chroma below
 * HIGHLIGHT_WHITE) or clearly less colourful than it (by HIGHLIGHT_FADED) are
 * specular highlights. Within HIGHLIGHT_PX of the outline they are replaced by
 * the colour of their non-highlight neighbours; further in the photo stays.
 * Bright but colourful texels (a cream label next to a black band) stay too.
 */
const HIGHLIGHT_NZ: [number, number] = [0.4, 0.6];
const HIGHLIGHT_EXCESS: [number, number] = [20, 50];
const HIGHLIGHT_WHITE: [number, number] = [18, 34];
const HIGHLIGHT_FADED: [number, number] = [15, 40];
const HIGHLIGHT_PX = 6;
/** Beyond HIGHLIGHT_PX only white specular streaks go, where |nz| falls through SPECULAR_NZ. */
const SPECULAR_NZ: [number, number] = [0.45, 0.3];
/**
 * Texels that define the interior colour: seen fairly face-on and clear of the
 * outline. Grazing texels of a photo hold rim highlights and backdrop tint.
 */
const INTERIOR_NZ = 0.55;
const INTERIOR_PX = 6;
/** Side/top photo blend ramps on the facing component of the normal, for real photos and for synthetic backs. */
const REAL_RAMP: [number, number] = [0.75, 0.97];
const SYNTHETIC_RAMP: [number, number] = [0.25, 0.7];
/**
 * Where a real photo itself sees the surface at a grazing angle (|nz| falling
 * through GRAZING_NZ), it only has stretched or seam-filled colour there, so a
 * side/top photo takes over as soon as it sees the surface at all (facing
 * through GRAZING_RAMP), instead of only near face-on (REAL_RAMP).
 */
const GRAZING_NZ: [number, number] = [0.5, 0.3];
const GRAZING_RAMP: [number, number] = [0.1, 0.4];
/**
 * On the front half (the user's photo) side/top photos are faded out where
 * the photo still sees the surface reasonably well, so the model keeps the
 * photo's pixels everywhere but at its grazing rim.
 */
const FRONT_KEEP_NZ: [number, number] = [0.45, 0.2];
/**
 * Where the photo still sees the surface (|nz| above PHOTO_TRUST_NZ), a side or
 * top colour more than about AGREE_DE (Lab, lightness at half weight) away
 * from the photo's own colour there is faded out instead of blended in.
 */
const PHOTO_TRUST_NZ: [number, number] = [0.15, 0.3];
const PHOTO_TRUST_PX: [number, number] = [RIM_PX, RIM_PX + 3];
/**
 * Side/top photos are graded to the photo line by line (gains within
 * GAIN_RANGE, smoothed over GAIN_SIGMA of the lines), fully where they meet the
 * photo and fading out towards the outline (|nz| through GAIN_FADE_NZ), where
 * the front and back halves meet.
 */
const GAIN_RANGE: [number, number] = [0.6, 1.6];
const GAIN_SIGMA = 0.03;
const GAIN_FADE_NZ: [number, number] = [0.05, 0.3];
const AGREE_DE = 30;
/** A texel counts as seen by a side/top photo within this many grid px of the outermost surface at its depth. */
const VISIBLE_PX = 2;
/** Smoothing of the per-row (per-column) placement of side (top) photos, in grid lines. */
const PLACEMENT_SIGMA = 2.5;

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

/**
 * Front-to-back depth range of every grid row and column, used to place points
 * in side/top photos. Smoothed across lines so the placement does not jump
 * from row to row with the jitter of the outline.
 */
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
    const ok = new Uint8Array(lo.length);
    for (let k = 0; k < lo.length; k++) ok[k] = Number.isFinite(lo[k]) ? 1 : 0;
    const sLo = smoothLine(lo, ok, PLACEMENT_SIGMA);
    const sHi = smoothLine(hi, ok, PLACEMENT_SIGMA);
    for (let k = 0; k < lo.length; k++) {
      lo[k] = ok[k] ? sLo[k] : 0;
      hi[k] = ok[k] ? sHi[k] : 1;
    }
  };
  fix(rowMin, rowMax);
  fix(colMin, colMax);
  return { rowMin, rowMax, colMin, colMax };
}

/** Gaussian smoothing of a 1-D profile over its valid entries only (normalised convolution). */
function smoothLine(v: Float32Array, valid: Uint8Array, sigma: number): Float32Array {
  const n = v.length;
  const out = new Float32Array(v);
  if (sigma <= 0.01) return out;
  const r = Math.ceil(sigma * 3);
  for (let k = 0; k < n; k++) {
    if (!valid[k]) continue;
    let acc = 0;
    let ws = 0;
    for (let d = -r; d <= r; d++) {
      const q = k + d;
      if (q < 0 || q >= n || !valid[q]) continue;
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      acc += v[q] * w;
      ws += w;
    }
    out[k] = acc / ws;
  }
  return out;
}

/** Span table with its per-line extents smoothed over `sigma` lines (first and last line unchanged). */
function smoothSpans(s: Spans, sigma: number): Spans {
  const valid = new Uint8Array(s.count);
  for (let k = s.first; k <= s.last; k++) valid[k] = 1;
  const lo = smoothLine(s.lo, valid, sigma);
  const hi = smoothLine(s.hi, valid, sigma);
  for (let k = 0; k < s.count; k++) {
    if (k < s.first || k > s.last) {
      lo[k] = s.lo[k];
      hi[k] = s.hi[k];
    }
  }
  return { ...s, lo, hi };
}

type ViewKind = 'left' | 'right' | 'top';

/**
 * Which surface texels a side or top photo actually sees: a depth-binned
 * z-buffer of the solid between the two layers, looked at from +x, -x or +y.
 * For every line across the view direction (a grid row for side views, a
 * column for the top view) and depth bin it stores the outermost occupied
 * grid position.
 */
function outermost(kind: ViewKind, zF: Float32Array, zB: Float32Array, inside: Uint8Array, W: number, H: number) {
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let p = 0; p < W * H; p++) {
    if (!inside[p]) continue;
    zMin = Math.min(zMin, zB[p]);
    zMax = Math.max(zMax, zF[p]);
  }
  if (!Number.isFinite(zMin)) zMin = zMax = 0;
  const nb = Math.max(1, Math.ceil(zMax - zMin) + 2);
  const lines = kind === 'top' ? W : H;
  const best = new Float32Array(lines * nb).fill(kind === 'right' ? -Infinity : Infinity);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p]) continue;
      const b0 = Math.max(0, Math.ceil(zB[p] - zMin - 0.5));
      const b1 = Math.min(nb - 1, Math.floor(zF[p] - zMin + 0.5));
      const line = kind === 'top' ? i : j;
      const pos = kind === 'top' ? j : i;
      for (let b = b0; b <= b1; b++) {
        const k = line * nb + b;
        if (kind === 'right' ? pos > best[k] : pos < best[k]) best[k] = pos;
      }
    }
  }
  return { zMin, nb, best };
}

/**
 * Per-grid-pixel visibility (0..1) of one layer from a side/top view, extrapolated
 * outside the silhouette so bilinear lookups at the outline stay sane.
 */
function layerVisibility(occ: ReturnType<typeof outermost>, kind: ViewKind, z: Float32Array, inside: Uint8Array, W: number, H: number): FloatField {
  const vis = new Float32Array(W * H);
  const wts = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p]) continue;
      const b = clamp(Math.round(z[p] - occ.zMin), 0, occ.nb - 1);
      const line = kind === 'top' ? i : j;
      const edge = occ.best[line * occ.nb + b];
      const d = kind === 'top' ? j - edge : kind === 'right' ? edge - i : i - edge;
      vis[p] = Number.isFinite(d) ? 1 - smoothstep(VISIBLE_PX, 2 * VISIBLE_PX, d) : 0;
      wts[p] = 1;
    }
  }
  return { width: W, height: H, data: pushPull(vis, wts, W, H, 1) };
}

/** Bilinear lookup of a grid field at every texel centre. */
function texelField(grid: Float32Array, W: number, H: number, TW: number, TH: number): Float32Array {
  const f = { width: W, height: H, data: grid };
  const out = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) {
    const gj = ((y + 0.5) / TH) * H - 0.5;
    for (let x = 0; x < TW; x++) out[y * TW + x] = sampleFloat(f, ((x + 0.5) / TW) * W - 0.5, gj);
  }
  return out;
}

/** Layer depths with values outside the silhouette extrapolated (they are 0 there otherwise). */
function filledDepth(z: Float32Array, inside: Uint8Array, W: number, H: number): FloatField {
  const wts = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) wts[p] = inside[p] ? 1 : 0;
  return { width: W, height: H, data: pushPull(z, wts, W, H, 1) };
}

/**
 * Normalised blur of `w` along x (`along` = 'x') or y, counting only texels where
 * `m` is set: three box passes approximating a Gaussian of `sigma`.
 */
function blurAlong(w: Float32Array, m: Uint8Array, TW: number, TH: number, sigma: number, along: 'x' | 'y'): Float32Array {
  const out = new Float32Array(w.length);
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  const lines = along === 'y' ? TW : TH;
  const len = along === 'y' ? TH : TW;
  const step = along === 'y' ? TW : 1;
  let a = new Float32Array(len), b = new Float32Array(len);
  let ta = new Float32Array(len), tb = new Float32Array(len);
  for (let l = 0; l < lines; l++) {
    const base = along === 'y' ? l : l * TW;
    let any = false;
    for (let k = 0; k < len; k++) {
      const i = base + k * step;
      b[k] = m[i] ? 1 : 0;
      a[k] = m[i] ? w[i] : 0;
      if (a[k] > 0) any = true;
    }
    if (!any) continue;
    for (let pass = 0; pass < 3; pass++) {
      boxLine(a, ta, len, r);
      boxLine(b, tb, len, r);
      [a, ta] = [ta, a];
      [b, tb] = [tb, b];
    }
    for (let k = 0; k < len; k++) {
      const i = base + k * step;
      if (m[i]) out[i] = b[k] > 1e-6 ? a[k] / b[k] : 0;
    }
  }
  return out;
}

/** Running-sum box filter of radius `r` over one line (zero outside). */
function boxLine(src: Float32Array, dst: Float32Array, len: number, r: number): void {
  let acc = 0;
  for (let k = 0; k < Math.min(r, len); k++) acc += src[k];
  for (let k = 0; k < len; k++) {
    if (k + r < len) acc += src[k + r];
    if (k - r - 1 >= 0) acc -= src[k - r - 1];
    dst[k] = acc;
  }
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

/** Colour distance (RGB) at which a texel's weight in the tone texture drops to 1/e. */
const TONE_SIGMA = 60;

/** Per-channel blur of `small` weighted by `wts` (normalised), plus the blurred weight. */
function weightedBlur(small: RGBAImage, wts: Float32Array, sigma: number): { rgb: Float32Array; weight: Float32Array } {
  const { width: w, height: h } = small;
  const n = w * h;
  const weight = blurBuffer(wts, w, h, sigma);
  const rgb = new Float32Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = small.data[i * 4 + c] * wts[i];
    const b = blurBuffer(ch, w, h, sigma);
    for (let i = 0; i < n; i++) rgb[i * 3 + c] = weight[i] > 1e-6 ? b[i] / weight[i] : 128;
  }
  return { rgb, weight };
}

/**
 * Heavily blurred, detail-free version of the front colours ("what colour is
 * the back probably?"). Small decals, print and highlights are down-weighted
 * against the locally dominant colour first, so they do not smear into
 * blotches.
 */
function toneTexture(front: RGBAImage, mask: ByteField): RGBAImage {
  const s = 64 / Math.max(front.width, front.height);
  const w = Math.max(4, Math.round(front.width * s));
  const h = Math.max(4, Math.round(front.height * s));
  const n = w * h;
  const small = resizeRGBA(front, w, h);
  const m = resizeByte(mask, w, h);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = m.data[i] / 255;
  let wts = alpha;
  for (let pass = 0; pass < 2; pass++) {
    const dominant = weightedBlur(small, wts, 6).rgb;
    const next = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let d2 = 0;
      for (let c = 0; c < 3; c++) d2 += (small.data[i * 4 + c] - dominant[i * 3 + c]) ** 2;
      // A small floor keeps regions without a dominant colour (e.g. two-tone boundaries) at a plain blur.
      next[i] = alpha[i] * (0.02 + Math.exp(-d2 / (TONE_SIGMA * TONE_SIGMA)));
    }
    wts = next;
  }
  const { rgb, weight } = weightedBlur(small, wts, 4);
  const out = createRGBA(w, h);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = weight[i] > 1e-5 ? rgb[i * 3 + c] : 128;
    out.data[i * 4 + 3] = 255;
  }
  return resizeRGBA(out, front.width, front.height);
}

/**
 * Bakes the texture atlas. The front half is the user's photo itself (only
 * texels it sees at a grazing angle near the outline are cleaned), so the
 * model matches the photo pixel for pixel from the camera's viewpoint. The back half comes from a
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
  const highlights = harmoniseSeam(front, back, nfFront, nfBack, W, H, edgeDist, texInside);
  // The last couple of grid pixels before the outline become a near-vertical strip
  // on the model; smooth them along the outline so per-row jitter of the cut-out
  // does not turn into streaks (colours across the edge, e.g. dark outlines, stay).
  const gridPx = TW / W;
  const zone = Math.max(2, 2.5 * gridPx);
  tangentialRimBlur(front, edgeDist, zone, Math.max(1, gridPx));
  tangentialRimBlur(back, edgeDist, zone, Math.max(1, gridPx));

  const sides: SideView[] = [];
  if (t.left) sides.push({ ref: t.left, kind: 'left' });
  if (t.right) sides.push({ ref: t.right, kind: 'right' });
  if (t.top) sides.push({ ref: t.top, kind: 'top' });
  if (sides.length && t.sideBlend > 0 && spans) {
    const fields: SideField[] = [
      { img: front, z: t.zF, nf: nfFront, real: true, front: true, highlights },
      { img: back, z: t.zB, nf: nfBack, real: t.backTexture === 'reference', front: false },
    ];
    blendSideViews(t, fields, sides, mask, spans, edgeDist);
  }

  // Fill everything outside the silhouette from the final texels, so mip-mapping never
  // pulls in background and lookups at the outline (which straddle it) do not
  // alternate row by row between the rim texel and an older outside colour.
  const inMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) inMask[i] = mask.data[i] >= 64 ? 1 : 0;
  const frontFilled = bleedRGBA(front, inMask);
  const backFilled = bleedRGBA(back, inMask);
  unifyRim(frontFilled, backFilled, edgeDist, texInside);

  const atlas = createRGBA(layout.width, layout.height);
  const blit = (src: RGBAImage, ox: number) => {
    for (let y = 0; y < TH; y++) atlas.data.set(src.data.subarray(y * TW * 4, (y + 1) * TW * 4), (y * layout.width + ox) * 4);
  };
  blit(frontFilled, layout.front.x);
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

/** Tangent of the outline (unit vector) for texels within `zone` px inside it, or null elsewhere. */
function rimTangents(edgeDist: Float32Array, TW: number, TH: number, zone: number): (x: number, y: number) => [number, number] | null {
  const field = { width: TW, height: TH, data: blurBuffer(edgeDist, TW, TH, 1.5) };
  return (x, y) => {
    const e = edgeDist[y * TW + x];
    if (x < 1 || y < 1 || x >= TW - 1 || y >= TH - 1 || e <= 0 || e > zone) return null;
    const gx = sampleFloat(field, x + 1, y) - sampleFloat(field, x - 1, y);
    const gy = sampleFloat(field, x, y + 1) - sampleFloat(field, x, y - 1);
    const gl = Math.hypot(gx, gy);
    return gl < 1e-3 ? null : [-gy / gl, gx / gl];
  };
}

const RIM_TAPS = [-3, -2, -1, 0, 1, 2, 3];
const RIM_WEIGHTS = RIM_TAPS.map((t) => Math.exp(-(t * t) / 4.5));

/** Blur texels within `zone` px of the outline along the outline's tangent only. */
function tangentialRimBlur(img: RGBAImage, edgeDist: Float32Array, zone: number, sigma: number): void {
  const { width: TW, height: TH } = img;
  const tangent = rimTangents(edgeDist, TW, TH, zone);
  const srcImg: RGBAImage = { width: TW, height: TH, data: new Uint8ClampedArray(img.data) };
  const px = new Float32Array(4);
  for (let y = 1; y < TH - 1; y++) {
    for (let x = 1; x < TW - 1; x++) {
      const tv = tangent(x, y);
      if (!tv) continue;
      let r = 0, g = 0, b = 0, ws = 0;
      for (let k = 0; k < RIM_TAPS.length; k++) {
        const off = (RIM_TAPS[k] * sigma) / 1.5;
        sampleRGBA(srcImg, x + tv[0] * off, y + tv[1] * off, px);
        r += px[0] * RIM_WEIGHTS[k];
        g += px[1] * RIM_WEIGHTS[k];
        b += px[2] * RIM_WEIGHTS[k];
        ws += RIM_WEIGHTS[k];
      }
      const w = 1 - smoothstep(zone * 0.5, zone, edgeDist[y * TW + x]);
      const o = (y * TW + x) * 4;
      img.data[o] += (r / ws - img.data[o]) * w;
      img.data[o + 1] += (g / ws - img.data[o + 1]) * w;
      img.data[o + 2] += (b / ws - img.data[o + 2]) * w;
    }
  }
}

/**
 * Low-frequency colours of the texels marked `ok`, extended smoothly over the
 * rest of the texture (filled and blurred at reduced resolution, then upsampled).
 */
function softInterior(img: RGBAImage, ok: Uint8Array): RGBAImage {
  const s = Math.min(1, 192 / Math.max(img.width, img.height));
  const w = Math.max(4, Math.round(img.width * s));
  const h = Math.max(4, Math.round(img.height * s));
  const n = img.width * img.height;
  const field = (data: Float32Array) => resizeFloat({ width: img.width, height: img.height, data }, w, h).data;
  const cover = field(Float32Array.from(ok));
  const vals = new Float32Array(w * h * 3);
  const wts = new Float32Array(w * h);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = ok[i] ? img.data[i * 4 + c] : 0;
    const small = field(ch);
    for (let k = 0; k < w * h; k++) vals[k * 3 + c] = cover[k] > 0 ? small[k] / cover[k] : 0;
  }
  for (let k = 0; k < w * h; k++) wts[k] = Math.min(1, cover[k] * 2);
  const filled = pushPull(vals, wts, w, h, 3);
  const out = createRGBA(w, h);
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) ch[k] = filled[k * 3 + c];
    const b = blurBuffer(ch, w, h, 1.5);
    for (let k = 0; k < w * h; k++) out.data[k * 4 + c] = b[k];
  }
  for (let k = 0; k < w * h; k++) out.data[k * 4 + 3] = 255;
  return resizeRGBA(out, img.width, img.height);
}

function luma(d: Uint8ClampedArray, o: number): number {
  return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
}

/** Separable square maximum filter of radius `r`. */
function maxFilter(v: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(v.length);
  const out = new Float32Array(v.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = v[row + x];
      const hi = Math.min(w - 1, x + r);
      for (let d = Math.max(0, x - r); d <= hi; d++) if (v[row + d] > m) m = v[row + d];
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const lo = Math.max(0, y - r);
    const hi = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let m = tmp[y * w + x];
      for (let d = lo; d <= hi; d++) if (tmp[d * w + x] > m) m = tmp[d * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Separable [1 2 1] / 4 smoothing (clamp to edge). */
function smooth3(v: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(v.length);
  const out = new Float32Array(v.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) tmp[row + x] = (v[row + Math.max(0, x - 1)] + 2 * v[row + x] + v[row + Math.min(w - 1, x + 1)]) / 4;
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const down = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[y * w + x] = (tmp[up + x] + 2 * tmp[y * w + x] + tmp[down + x]) / 4;
  }
  return out;
}

/** Texels clear of the outline and seen fairly face-on; the criteria relax step by step when too few qualify (thin or edge-on objects). */
function interiorTexels(absNz: Float32Array, edgeDist: Float32Array, texInside: Uint8Array, band: number): Uint8Array {
  const n = absNz.length;
  const tries: [number, number][] = [
    [band, INTERIOR_NZ],
    [band, 0],
    [1.5, 0],
    [0, 0],
  ];
  for (const [minDist, minNz] of tries) {
    const ok = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (texInside[i] && edgeDist[i] > minDist && absNz[i] > minNz) {
        ok[i] = 1;
        count++;
      }
    }
    if (count >= 16) return ok;
  }
  return new Uint8Array(texInside);
}

/**
 * Where the surface turns away from the camera the photo has almost no pixels,
 * so the outermost colours get stretched into streaks, and front and back
 * textures meet with a hard seam. Fade both halves towards the same smooth
 * interior colour there. Only texels the camera sees at a grazing angle are
 * touched: the outermost few pixels, plus bright streaks (rim lights) a little
 * further in. The interior colour comes from texels seen fairly face-on and
 * clear of the outline only, because a photo's grazing rim holds rim
 * highlights, Fresnel reflections and backdrop tint.
 */
function harmoniseSeam(
  front: RGBAImage,
  back: RGBAImage,
  nfF: NormalField,
  nfB: NormalField,
  W: number,
  H: number,
  edgeDist: Float32Array,
  texInside: Uint8Array,
): Float32Array {
  const TW = front.width;
  const TH = front.height;
  const n = TW * TH;
  const fz = { width: W, height: H, data: nfF.nz };
  const bz = { width: W, height: H, data: nfB.nz };
  const azF = new Float32Array(n);
  const azB = new Float32Array(n);
  for (let y = 0; y < TH; y++) {
    const gj = ((y + 0.5) / TH) * H - 0.5;
    for (let x = 0; x < TW; x++) {
      const gi = ((x + 0.5) / TW) * W - 0.5;
      azF[y * TW + x] = Math.abs(sampleFloat(fz, gi, gj));
      azB[y * TW + x] = Math.abs(sampleFloat(bz, gi, gj));
    }
  }
  const scale = Math.max(1, Math.max(TW, TH) / 1024);
  const okF = interiorTexels(azF, edgeDist, texInside, INTERIOR_PX * scale);
  const okB = interiorTexels(azB, edgeDist, texInside, INTERIOR_PX * scale);
  const softF = softInterior(front, okF);
  const softB = softInterior(back, okB);
  const highlightF = suppressHighlights(front, okF, azF, edgeDist, texInside, scale);
  suppressHighlights(back, okB, azB, edgeDist, texInside, scale);
  const rimPx = RIM_PX * scale;
  for (let i = 0; i < n; i++) {
    const hi = SEAM_HI_RIM + (SEAM_HI - SEAM_HI_RIM) * smoothstep(rimPx * 0.6, rimPx, edgeDist[i]);
    const wf = 1 - smoothstep(SEAM_LO, hi, azF[i]);
    const wb = 1 - smoothstep(SEAM_LO, hi, azB[i]);
    if (wf <= 0 && wb <= 0) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const avg = (softF.data[o + c] + softB.data[o + c]) / 2;
      front.data[o + c] += (avg - front.data[o + c]) * wf;
      back.data[o + c] += (avg - back.data[o + c]) * wb;
    }
  }
  return highlightF;
}

function chroma(d: Uint8ClampedArray, o: number): number {
  return Math.max(d[o], d[o + 1], d[o + 2]) - Math.min(d[o], d[o + 1], d[o + 2]);
}

/**
 * Find specular highlights where the photo sees the surface at a grazing
 * angle (much brighter than the nearby interior, and white or paler than it)
 * and replace them by the colour of the texels around them, within `cap` px
 * of the outline only. Returns the highlight map (0..1).
 */
function suppressHighlights(
  img: RGBAImage,
  ok: Uint8Array,
  absNz: Float32Array,
  edgeDist: Float32Array,
  texInside: Uint8Array,
  scale: number,
): Float32Array {
  const { width: TW, height: TH } = img;
  const n = TW * TH;
  const cap = HIGHLIGHT_PX * scale;
  // Interior colour around every texel; its luminance is taken as the brightest
  // within a few px, so a bright region next to a dark one (a label's edge) is
  // its own reference.
  const interior = bleedRGBA(img, ok);
  const iLum = new Float32Array(n);
  for (let i = 0; i < n; i++) iLum[i] = luma(interior.data, i * 4);
  const refLum = maxFilter(iLum, TW, TH, Math.round(3 * scale));
  const excess = new Float32Array(n);
  const pale = new Float32Array(n);
  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!texInside[i] || absNz[i] >= HIGHLIGHT_NZ[1]) continue;
    const o = i * 4;
    excess[i] = Math.max(0, luma(img.data, o) - refLum[i]);
    const c = chroma(img.data, o);
    white[i] = 1 - smoothstep(HIGHLIGHT_WHITE[0], HIGHLIGHT_WHITE[1], c);
    pale[i] = Math.max(white[i], smoothstep(HIGHLIGHT_FADED[0], HIGHLIGHT_FADED[1], chroma(interior.data, o) - c));
  }
  // Pixel noise and fine print stay below the threshold once averaged a little; streaks do not.
  const e = smooth3(excess, TW, TH);
  const p = smooth3(pale, TW, TH);
  const wh = smooth3(white, TW, TH);
  const hit = new Float32Array(n);
  const spec = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const bright = smoothstep(HIGHLIGHT_EXCESS[0], HIGHLIGHT_EXCESS[1], e[i]);
    hit[i] = bright * p[i];
    spec[i] = bright * wh[i];
  }
  // Widen each detection by a couple of pixels so the soft flanks of a streak go too.
  const r = Math.round(2 * scale);
  const grown = maxFilter(hit, TW, TH, r);
  const grownSpec = maxFilter(spec, TW, TH, r);
  const w = new Float32Array(n);
  const keep = new Uint8Array(n);
  let sources = 0;
  let any = false;
  for (let i = 0; i < n; i++) {
    // Fill from texels clear of highlights and of the outermost rim, whose colours
    // are mixed with the backdrop and Fresnel reflections.
    keep[i] = texInside[i] && grown[i] < 0.05 && edgeDist[i] >= cap ? 1 : 0;
    sources += keep[i];
    if (grown[i] <= 0) continue;
    // Near the outline any highlight goes; further in only white specular streaks
    // where the photo itself sees the surface at a grazing angle.
    const nearRim = 1 - smoothstep(cap - 1.5 * scale, cap, edgeDist[i]);
    const further = grownSpec[i] * smoothstep(SPECULAR_NZ[0], SPECULAR_NZ[1], absNz[i]);
    w[i] = (1 - smoothstep(HIGHLIGHT_NZ[0], HIGHLIGHT_NZ[1], absNz[i])) * Math.max(grown[i] * nearRim, further);
    if (w[i] > 0) any = true;
  }
  if (!any) return grown;
  if (sources < 16) for (let i = 0; i < n; i++) keep[i] = texInside[i] && grown[i] < 0.05 ? 1 : 0;
  // Highlights take the colour of the texels around them (local, so a black band
  // next to a cream label keeps both colours).
  const fill = bleedRGBA(img, keep);
  for (let i = 0; i < n; i++) {
    if (w[i] <= 0) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) img.data[o + c] += (fill.data[o + c] - img.data[o + c]) * w[i];
  }
  return grown;
}

/**
 * The side wall carries the outermost texel of each half, front on one side of
 * its middle line and back on the other. Give both halves the same colour
 * there (and just outside, where bilinear lookups at the outline reach) so the
 * wall reads as one colour instead of a thin line.
 */
function unifyRim(front: RGBAImage, back: RGBAImage, edgeDist: Float32Array, texInside: Uint8Array): void {
  const { width: TW, height: TH } = front;
  const n = TW * TH;
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = texInside[i] ? 0 : 1;
  const outDist = distanceTransform(outside, TW, TH).data;
  for (let i = 0; i < n; i++) {
    const w = texInside[i] ? 1 - smoothstep(1.5, 2.5, edgeDist[i]) : outDist[i] <= 2.5 ? 1 : 0;
    if (w <= 0) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const avg = (front.data[o + c] + back.data[o + c]) / 2;
      front.data[o + c] += (avg - front.data[o + c]) * w;
      back.data[o + c] += (avg - back.data[o + c]) * w;
    }
  }
}

interface SideView {
  ref: TextureRef;
  kind: ViewKind;
}

interface SideField {
  img: RGBAImage;
  z: Float32Array;
  nf: NormalField;
  /** A real photo (front, back reference) rather than a synthetic back. */
  real: boolean;
  /** The user's photo: side/top photos only replace its grazing rim. */
  front: boolean;
  /** Specular highlights found in the photo (0..1 per texel). */
  highlights?: Float32Array;
}

/**
 * Side and top references replace texels that the photo only sees at a
 * grazing angle and that the reference itself sees (nothing in front of
 * them along its view direction). Placement and weights are smoothed along
 * the outline so rows do not alternate between sources.
 */
function blendSideViews(
  t: TextureInput,
  fields: SideField[],
  sides: SideView[],
  mask: ByteField,
  spans: { rows: Spans; cols: Spans },
  edgeDist: Float32Array,
): void {
  const { gridW: W, gridH: H, inside } = t;
  const TW = mask.width;
  const TH = mask.height;
  const n = TW * TH;
  const rimRamp = 2.5 * Math.max(1, TW / W);
  const scale = Math.max(1, Math.max(TW, TH) / 1024);
  const trustPx = [PHOTO_TRUST_PX[0] * scale, PHOTO_TRUST_PX[1] * scale];
  const mid = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) mid[p] = (t.zF[p] + t.zB[p]) / 2;
  const midTex = texelField(blurBuffer(filledDepth(mid, inside, W, H).data, W, H, 1.5), W, H, TW, TH);
  const ext = extents(t.zF, t.zB, inside, W, H);
  const on = new Uint8Array(n);
  for (let i = 0; i < n; i++) on[i] = mask.data[i] >= 64 ? 1 : 0;
  const occ = new Map<ViewKind, ReturnType<typeof outermost>>();
  for (const s of sides) occ.set(s.kind, outermost(s.kind, t.zF, t.zB, inside, W, H));
  // Reference spans smoothed over the same number of object lines as the model's extents.
  const refSpans = sides.map((s) => {
    const top = s.kind === 'top';
    const own = top ? spans.cols : spans.rows;
    const ref = top ? s.ref.cols : s.ref.rows;
    const linesPerGrid = ((top ? TW / W : TH / H) * (ref.last - ref.first)) / Math.max(1, own.last - own.first);
    return smoothSpans(ref, PLACEMENT_SIGMA * Math.max(1, linesPerGrid));
  });
  /** Colour of side/top photo `k` at the texel (x, y), grid position (gi, gj) and depth z. */
  const sampleSide = (k: number, x: number, y: number, gi: number, gj: number, z: number, out: Float32Array) => {
    const s = sides[k];
    const ref = refSpans[k];
    let sx: number, sy: number;
    if (s.kind === 'top') {
      sx = spanLineAt(ref, clamp(spanT(spans.cols, x), 0, 1));
      const [top, bottom] = spanAt(ref, sx);
      const zMin = lerpArr(ext.colMin, gi), zMax = lerpArr(ext.colMax, gi);
      const v = zMax > zMin ? (z - zMin) / (zMax - zMin) : 0.5;
      sy = top + clamp(v, 0, 1) * (bottom - top);
    } else {
      sy = spanLineAt(ref, clamp(spanT(spans.rows, y), 0, 1));
      const [l, rr] = spanAt(ref, sy);
      const zMin = lerpArr(ext.rowMin, gj), zMax = lerpArr(ext.rowMax, gj);
      let u = zMax > zMin ? (z - zMin) / (zMax - zMin) : 0.5;
      // Seen from the right the object's front is on the image's left, and vice versa.
      if (s.kind === 'right') u = 1 - u;
      sx = l + clamp(u, 0, 1) * (rr - l);
    }
    sampleRGBA(s.ref.image, sx, sy, out);
  };
  const px = new Float32Array(4);
  const lab = [0, 0, 0];
  for (const f of fields) {
    const [lo, hi] = f.real ? REAL_RAMP : SYNTHETIC_RAMP;
    // Depth per texel for placing it in the side photo. The grid's depth steps from
    // row to row along the outline (the mesh snaps those vertices onto the cut-out,
    // the grid does not), which would put whole rows on different side-photo
    // columns: blur it, and near the outline follow the true distance to it, so
    // both layers meet on the middle line there.
    const zTex = texelField(blurBuffer(filledDepth(f.z, inside, W, H).data, W, H, 1.5), W, H, TW, TH);
    for (let i = 0; i < n; i++) zTex[i] = midTex[i] + (zTex[i] - midTex[i]) * Math.min(1, edgeDist[i] / rimRamp);
    const nxF = { width: W, height: H, data: f.nf.nx };
    const nyF = { width: W, height: H, data: f.nf.ny };
    const absNz = texelField(f.nf.nz, W, H, TW, TH);
    for (let i = 0; i < n; i++) absNz[i] = Math.abs(absNz[i]);
    const weights = sides.map((s) => {
      const vis = layerVisibility(occ.get(s.kind)!, s.kind, f.z, inside, W, H);
      const w = new Float32Array(n);
      for (let y = 0; y < TH; y++) {
        const gj = ((y + 0.5) / TH) * H - 0.5;
        for (let x = 0; x < TW; x++) {
          const i = y * TW + x;
          if (!on[i]) continue;
          const gi = ((x + 0.5) / TW) * W - 0.5;
          const facing = s.kind === 'right' ? sampleFloat(nxF, gi, gj) : s.kind === 'left' ? -sampleFloat(nxF, gi, gj) : sampleFloat(nyF, gi, gj);
          let ramp = smoothstep(lo, hi, facing);
          if (f.real) {
            if (s.kind !== 'top') {
              // Only surfaces that face the side more than up or down: the row placement
              // of a side photo is least certain there (e.g. under a beak or a chin).
              const upDown = Math.abs(sampleFloat(nyF, gi, gj));
              const grazing = smoothstep(GRAZING_RAMP[0], GRAZING_RAMP[1], facing) * smoothstep(0, 0.2, facing - upDown);
              ramp = Math.max(ramp, grazing * smoothstep(GRAZING_NZ[0], GRAZING_NZ[1], absNz[i]));
            }
            if (f.front) ramp *= smoothstep(FRONT_KEEP_NZ[0], FRONT_KEEP_NZ[1], absNz[i]);
          }
          w[i] = t.sideBlend * ramp * clamp(sampleFloat(vis, gi, gj), 0, 1);
        }
      }
      // Side photos are placed row by row, the top photo column by column.
      return blurAlong(w, on, TW, TH, PLACEMENT_SIGMA * (s.kind === 'top' ? TW / W : TH / H), s.kind === 'top' ? 'x' : 'y');
    });
    if (!f.real) {
      mixSides(f, weights, null, null, absNz, zTex);
      continue;
    }
    // How far the photo's own colour can be relied on: clear of its outermost rim
    // (backdrop bleed, Fresnel tint) or where it sees the surface at all, and not
    // on a highlight.
    const photoLab = imageToLab(f.img);
    const trust = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      const seen = Math.max(smoothstep(PHOTO_TRUST_NZ[0], PHOTO_TRUST_NZ[1], absNz[i]), smoothstep(trustPx[0], trustPx[1], edgeDist[i]));
      trust[i] = seen * (1 - (f.highlights?.[i] ?? 0));
    }
    const agreeAt = (i: number, c: Float32Array) => {
      rgbToLab(clamp(Math.round(c[0]), 0, 255), clamp(Math.round(c[1]), 0, 255), clamp(Math.round(c[2]), 0, 255), lab);
      const dL = (lab[0] - photoLab[i * 3]) / 2;
      const da = lab[1] - photoLab[i * 3 + 1];
      const db = lab[2] - photoLab[i * 3 + 2];
      return Math.exp(-(dL * dL + da * da + db * db) / (AGREE_DE * AGREE_DE));
    };
    // Exposure and white balance of each side/top photo, matched line by line to the
    // photo where both see the same surface, so the two do not meet with a step.
    const gains = sides.map((s, k) => {
      const top = s.kind === 'top';
      const lines = top ? TW : TH;
      const acc = new Float64Array(lines * 7);
      for (let y = 0; y < TH; y++) {
        const gj = ((y + 0.5) / TH) * H - 0.5;
        for (let x = 0; x < TW; x++) {
          const i = y * TW + x;
          const w = weights[k][i];
          if (w <= 0.02 || trust[i] <= 0.5) continue;
          sampleSide(k, x, y, ((x + 0.5) / TW) * W - 0.5, gj, zTex[i], px);
          const ww = w * trust[i] * agreeAt(i, px);
          if (ww <= 1e-3) continue;
          const o = (top ? x : y) * 7;
          for (let c = 0; c < 3; c++) {
            acc[o + c] += f.img.data[i * 4 + c] * ww;
            acc[o + 3 + c] += px[c] * ww;
          }
          acc[o + 6] += ww;
        }
      }
      return lineGains(acc, lines);
    });
    // Where the photo's colour is reliable, a side/top colour that still disagrees with
    // it is most likely misplaced (e.g. a side view's beak landing a little too low, on
    // the chin): its share of the blend is scaled down. Only on the front half, which
    // is the user's photo.
    const agreement = sides.map((_s, k) => {
      if (!f.front) return null;
      const a = new Float32Array(n).fill(1);
      for (let y = 0; y < TH; y++) {
        const gj = ((y + 0.5) / TH) * H - 0.5;
        for (let x = 0; x < TW; x++) {
          const i = y * TW + x;
          if (weights[k][i] <= 1e-4 || trust[i] <= 0) continue;
          sampleGraded(k, x, y, ((x + 0.5) / TW) * W - 0.5, gj, zTex[i], gains[k], absNz[i], px);
          a[i] = 1 - trust[i] * (1 - agreeAt(i, px));
        }
      }
      return a;
    });
    mixSides(f, weights, agreement, gains, absNz, zTex);
  }

  /** `sampleSide` with the side photo's colour graded by its per-line gains, fading out towards the outline. */
  function sampleGraded(k: number, x: number, y: number, gi: number, gj: number, z: number, g: Float32Array | null, absNz: number, out: Float32Array) {
    sampleSide(k, x, y, gi, gj, z, out);
    if (!g) return;
    const o = (sides[k].kind === 'top' ? x : y) * 3;
    const fade = smoothstep(GAIN_FADE_NZ[0], GAIN_FADE_NZ[1], absNz);
    for (let c = 0; c < 3; c++) out[c] *= 1 + (g[o + c] - 1) * fade;
  }

  /** Blend the side/top photos into one atlas half. */
  function mixSides(f: SideField, weights: Float32Array[], agreement: (Float32Array | null)[] | null, gains: (Float32Array | null)[] | null, absNz: Float32Array, zTex: Float32Array) {
    for (let y = 0; y < TH; y++) {
      const gj = ((y + 0.5) / TH) * H - 0.5;
      for (let x = 0; x < TW; x++) {
        const i = y * TW + x;
        if (!on[i]) continue;
        const gi = ((x + 0.5) / TW) * W - 0.5;
        let wSum = absNz[i] * absNz[i] + 0.02;
        const o = i * 4;
        let r = f.img.data[o] * wSum, g = f.img.data[o + 1] * wSum, b = f.img.data[o + 2] * wSum;
        let wSides = 0;
        let aSum = 0;
        for (let k = 0; k < sides.length; k++) {
          const w = weights[k][i];
          if (w <= 1e-4) continue;
          sampleGraded(k, x, y, gi, gj, zTex[i], gains?.[k] ?? null, absNz[i], px);
          r += px[0] * w;
          g += px[1] * w;
          b += px[2] * w;
          wSum += w;
          wSides += w;
          aSum += w * (agreement?.[k]?.[i] ?? 1);
        }
        if (wSides <= 0) continue;
        const share = aSum / wSides;
        f.img.data[o] += (r / wSum - f.img.data[o]) * share;
        f.img.data[o + 1] += (g / wSum - f.img.data[o + 1]) * share;
        f.img.data[o + 2] += (b / wSum - f.img.data[o + 2]) * share;
      }
    }
  }
}

/**
 * Per-line colour gains (photo / side photo, 3 per line) from accumulated sums
 * (photo rgb, side rgb, weight; 7 per line), smoothed along the lines and
 * falling back to the overall gain where a line has little overlap. Null when
 * there is no overlap at all.
 */
function lineGains(acc: Float64Array, lines: number): Float32Array | null {
  const total = [0, 0, 0, 0, 0, 0, 0];
  for (let l = 0; l < lines; l++) for (let c = 0; c < 7; c++) total[c] += acc[l * 7 + c];
  if (total[6] <= 1) return null;
  const global = [0, 1, 2].map((c) => clamp(total[c] / Math.max(1, total[3 + c]), GAIN_RANGE[0], GAIN_RANGE[1]));
  const valid = new Uint8Array(lines).fill(1);
  const sigma = Math.max(2, lines * GAIN_SIGMA);
  const smooth = [0, 1, 2, 3, 4, 5, 6].map((c) => {
    const v = new Float32Array(lines);
    for (let l = 0; l < lines; l++) v[l] = acc[l * 7 + c];
    return smoothLine(v, valid, sigma);
  });
  const out = new Float32Array(lines * 3);
  for (let l = 0; l < lines; l++) {
    // Average overlap weight per line within the smoothing window, against a couple of texels.
    const a = smooth[6][l] / (smooth[6][l] + 2);
    for (let c = 0; c < 3; c++) {
      const local = smooth[3 + c][l] > 1e-3 ? smooth[c][l] / smooth[3 + c][l] : global[c];
      out[l * 3 + c] = clamp(a * local + (1 - a) * global[c], GAIN_RANGE[0], GAIN_RANGE[1]);
    }
  }
  return out;
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
