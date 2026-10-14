import type { ByteField, RGBAImage, ViewName } from '../core/types';

export type CandidateView = 'front' | 'back' | 'side' | 'top';
export const CANDIDATE_VIEWS: CandidateView[] = ['front', 'back', 'side', 'top'];
export type Hint = 'any' | 'back' | 'side' | 'top';

export interface Scored {
  index: number;
  /** Similarity to the user's photo (CLIP cosine, or colour-histogram overlap without AI). */
  similarity: number;
  probs: Record<CandidateView, number>;
  view: CandidateView;
}

export function viewPrompts(label: string): Record<CandidateView, string> {
  return {
    front: `a photo of the front of a ${label}`,
    back: `a photo of the back of a ${label}, rear view`,
    side: `a side view photo of a ${label}, profile`,
    top: `a top-down photo of a ${label}, seen from above`,
  };
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** The search query that found a result is weak evidence of its viewpoint. */
function hintPrior(hint: Hint, view: CandidateView): number {
  if (hint === 'any') return view === 'front' ? 1.3 : 1;
  return hint === view ? 2 : 1;
}

function normalise(p: Record<CandidateView, number>): Record<CandidateView, number> {
  const s = CANDIDATE_VIEWS.reduce((a, v) => a + p[v], 0) || 1;
  const out = {} as Record<CandidateView, number>;
  for (const v of CANDIDATE_VIEWS) out[v] = p[v] / s;
  return out;
}

export function clipViewProbs(img: Float32Array, viewVecs: Record<CandidateView, Float32Array>, hint: Hint): Record<CandidateView, number> {
  const logits = CANDIDATE_VIEWS.map((v) => dot(img, viewVecs[v]) * 100);
  const max = Math.max(...logits);
  const raw = {} as Record<CandidateView, number>;
  CANDIDATE_VIEWS.forEach((v, i) => (raw[v] = Math.exp(logits[i] - max) * hintPrior(hint, v)));
  return normalise(raw);
}

export function hintOnlyProbs(hint: Hint): Record<CandidateView, number> {
  const raw = {} as Record<CandidateView, number>;
  for (const v of CANDIDATE_VIEWS) raw[v] = hint === 'any' ? (v === 'front' ? 0.55 : 0.15) : hint === v ? 0.7 : 0.1;
  return normalise(raw);
}

function argmax(p: Record<CandidateView, number>): CandidateView {
  return CANDIDATE_VIEWS.reduce((best, v) => (p[v] > p[best] ? v : best), 'front' as CandidateView);
}

export function scoreWithClip(input: Float32Array, candidates: Float32Array[], viewVecs: Record<CandidateView, Float32Array>, hints: Hint[]): Scored[] {
  return candidates.map((c, index) => {
    const probs = clipViewProbs(c, viewVecs, hints[index] ?? 'any');
    return { index, similarity: dot(input, c), probs, view: argmax(probs) };
  });
}

/**
 * Colour signature for ranking without AI: a joint hue/saturation/value
 * histogram of the central part of the image (where the object usually is).
 */
export function colorSignature(img: RGBAImage): Float32Array {
  const bins = new Float32Array(12 * 3 * 3);
  const x0 = Math.floor(img.width * 0.15), x1 = Math.ceil(img.width * 0.85);
  const y0 = Math.floor(img.height * 0.15), y1 = Math.ceil(img.height * 0.85);
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      const r = img.data[o] / 255, g = img.data[o + 1] / 255, b = img.data[o + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const v = max;
      const s = max > 0 ? (max - min) / max : 0;
      // Ignore near-white / near-black backdrop pixels.
      if ((v > 0.94 && s < 0.08) || v < 0.04) continue;
      let h = 0;
      if (max !== min) {
        if (max === r) h = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
      }
      const hi = Math.min(11, Math.floor((h / 6) * 12));
      const si = Math.min(2, Math.floor(s * 3));
      const vi = Math.min(2, Math.floor(v * 3));
      bins[(hi * 3 + si) * 3 + vi]++;
      total++;
    }
  }
  if (total > 0) for (let i = 0; i < bins.length; i++) bins[i] /= total;
  return bins;
}

/** Bhattacharyya coefficient between two normalised histograms (1 = identical). */
export function histogramSimilarity(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return s;
}

export function scoreWithColor(input: RGBAImage, candidates: RGBAImage[], hints: Hint[]): Scored[] {
  const sig = colorSignature(input);
  return candidates.map((c, index) => {
    const probs = hintOnlyProbs(hints[index] ?? 'any');
    return { index, similarity: histogramSimilarity(sig, colorSignature(c)), probs, view: argmax(probs) };
  });
}

// ---------------------------------------------------------------------------
// Which end of the object a side photo shows

/**
 * 'left' is the object's -x end, the one on the left of the main photo (seen by a
 * camera at -x); 'right' is the +x end.
 */
export type SideEnd = 'left' | 'right';

// 10° wide: orange and yellow, a beak and a duck, must not share a bin.
const HUE_BINS = 36;
const OBJECT_BINS = HUE_BINS * 2 + 4;

/**
 * Colours of an object for telling its ends apart: soft-binned hue at two
 * saturation levels for coloured pixels and four grey levels for the rest.
 * Brightness of coloured pixels is left out because every view is lit
 * differently. Counts pixels the mask marks as object (or the central region
 * without a mask) in columns [x0, x1).
 */
export function objectColors(img: RGBAImage, mask: ByteField | null, x0 = 0, x1 = img.width): Float32Array {
  const bins = new Float32Array(OBJECT_BINS);
  const cx0 = mask ? Math.max(0, x0) : Math.max(x0, Math.floor(img.width * 0.15));
  const cx1 = mask ? Math.min(img.width, x1) : Math.min(x1, Math.ceil(img.width * 0.85));
  const y0 = mask ? 0 : Math.floor(img.height * 0.15);
  const y1 = mask ? img.height : Math.ceil(img.height * 0.85);
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const p = y * img.width + x;
      // Soft edges mix in the backdrop.
      if (mask && mask.data[p] < 200) continue;
      const o = p * 4;
      const r = img.data[o] / 255, g = img.data[o + 1] / 255, b = img.data[o + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const s = max > 0 ? (max - min) / max : 0;
      if (!mask && ((max > 0.94 && s < 0.08) || max < 0.04)) continue;
      if (s < 0.18 || max < 0.12) {
        bins[HUE_BINS * 2 + Math.min(3, Math.floor(max * 4))]++;
      } else {
        let h = 0;
        if (max === r) h = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
        // Split between the two nearest hue bins, so close hues still overlap.
        const pos = (h / 6) * HUE_BINS - 0.5;
        const i0 = Math.floor(pos);
        const f = pos - i0;
        const off = s < 0.5 ? 0 : HUE_BINS;
        bins[off + ((i0 + HUE_BINS) % HUE_BINS)] += 1 - f;
        bins[off + ((i0 + 1) % HUE_BINS)] += f;
      }
      total++;
    }
  }
  if (total > 0) for (let i = 0; i < bins.length; i++) bins[i] /= total;
  return bins;
}

export interface EndColors {
  left: Float32Array;
  right: Float32Array;
}

/** Colours of the outermost `frac` of the cut-out's columns at each end of the main photo. */
export function frontEndColors(img: RGBAImage, mask: ByteField, frac = 0.25): EndColors | null {
  let x0 = img.width;
  let x1 = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[y * mask.width + x] < 200) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
  }
  if (x1 - x0 < 8) return null;
  const strip = Math.max(2, Math.round((x1 - x0 + 1) * frac));
  return { left: objectColors(img, mask, x0, x0 + strip), right: objectColors(img, mask, x1 + 1 - strip, x1 + 1) };
}

/** Hellinger distance between two normalised histograms (0 = identical, 1 = disjoint); a metric. */
function hellinger(a: Float32Array, b: Float32Array): number {
  return Math.sqrt(Math.max(0, 1 - histogramSimilarity(a, b)));
}

/** How different the colours at the two ends of the main photo are (Hellinger distance). */
export function endContrast(ends: EndColors): number {
  return hellinger(ends.left, ends.right);
}

export interface SideCall {
  end: SideEnd | null;
  /** How much closer the view's colours are to the left end than to the right end (Hellinger distance). */
  margin: number;
  /** How different the colours at the two ends of the main photo are (Hellinger distance). */
  contrast: number;
}

/** Ends whose colours differ less than this cannot be told apart (a plain bottle, a ball). */
export const MIN_END_CONTRAST = 0.12;
/** How much closer a side photo must be to one end than to the other. */
export const MIN_SIDE_MARGIN = 0.06;

/**
 * Decide which end of the object a side photo shows by comparing its colours
 * with the colours at the two ends of the main photo. Returns no end when the
 * ends look alike or the photo is about as close to both: painting the wrong
 * end (a beak on a duck's tail) is worse than painting none.
 */
export function whichEnd(side: Float32Array, ends: EndColors): SideCall {
  const contrast = endContrast(ends);
  // By the triangle inequality |margin| <= contrast.
  const margin = hellinger(side, ends.right) - hellinger(side, ends.left);
  const end = contrast >= MIN_END_CONTRAST && Math.abs(margin) >= MIN_SIDE_MARGIN ? (margin > 0 ? 'left' : 'right') : null;
  return { end, margin, contrast };
}

// ---------------------------------------------------------------------------
// Mirror-symmetric objects: a side view shows either end, only its orientation matters

/** How much a cut-out must overlap its own mirror image to count as mirror-symmetric. */
export const MIN_MIRROR_IOU = 0.97;

/** IoU of a cut-out with its mirror image about the middle of its bounding box (1 = a mirror-symmetric outline). */
export function mirrorSymmetry(mask: ByteField): number {
  const { width: W, height: H, data } = mask;
  let x0 = W;
  let x1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[y * W + x] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
  }
  if (x1 < x0) return 0;
  let inter = 0;
  let union = 0;
  for (let y = 0; y < H; y++) {
    for (let x = x0; x <= x1; x++) {
      const a = data[y * W + x] >= 128;
      const b = data[y * W + x0 + x1 - x] >= 128;
      if (a && b) inter++;
      if (a || b) union++;
    }
  }
  return union ? inter / union : 0;
}

/**
 * The photo's outline is mirror-symmetric and its two ends look alike (a bottle,
 * a vase): the object looks the same from either side, so any side view is valid
 * texture for both sides once it is turned the right way round. A mug's handle or
 * a duck's beak makes an object asymmetric.
 */
export function isMirrorSymmetric(mask: ByteField, ends: EndColors): boolean {
  return endContrast(ends) < MIN_END_CONTRAST && mirrorSymmetry(mask) >= MIN_MIRROR_IOU;
}

/** Rows of a cut-out are compared in this many bands, from its top to its bottom. */
const PROFILE_BANDS = 24;
/** The outermost part of each row that counts as its left or right edge strip. */
const EDGE_FRACTION = 0.3;

/** Mean colour (0..1 RGB, 3 values per row band) of a cut-out's left and right edge strips and of its whole rows; NaN where a band is empty. */
export interface EdgeProfiles {
  left: Float32Array;
  right: Float32Array;
  all: Float32Array;
}

/**
 * Colour profiles of a cut-out from top to bottom: per row band, the mean colour
 * of the outermost `frac` of each row's object pixels at its left and its right,
 * and of the whole row. Rows are measured from the cut-out's own top and bottom,
 * so views of different sizes line up.
 */
export function edgeProfiles(img: RGBAImage, mask: ByteField, bands = PROFILE_BANDS, frac = EDGE_FRACTION): EdgeProfiles | null {
  const { width: W, height: H } = mask;
  let y0 = H;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask.data[y * W + x] < 200) continue;
      if (y < y0) y0 = y;
      y1 = y;
      break;
    }
  }
  if (y1 - y0 < bands) return null;
  const sums = [new Float64Array(bands * 3), new Float64Array(bands * 3), new Float64Array(bands * 3)];
  const counts = [new Float64Array(bands), new Float64Array(bands), new Float64Array(bands)];
  for (let y = y0; y <= y1; y++) {
    let l = -1;
    let r = -1;
    for (let x = 0; x < W; x++) {
      if (mask.data[y * W + x] < 200) continue;
      if (l < 0) l = x;
      r = x;
    }
    if (l < 0) continue;
    const band = Math.min(bands - 1, Math.floor(((y - y0 + 0.5) / (y1 - y0 + 1)) * bands));
    const strip = (r - l + 1) * frac;
    for (let x = l; x <= r; x++) {
      const p = y * W + x;
      // Soft edges mix in the backdrop.
      if (mask.data[p] < 200) continue;
      const o = p * 4;
      const parts = [x - l < strip ? 0 : -1, r - x < strip ? 1 : -1, 2];
      for (const k of parts) {
        if (k < 0) continue;
        for (let c = 0; c < 3; c++) sums[k][band * 3 + c] += img.data[o + c] / 255;
        counts[k][band]++;
      }
    }
  }
  const [left, right, all] = sums.map((s, k) => {
    const out = new Float32Array(bands * 3);
    for (let i = 0; i < out.length; i++) out[i] = counts[k][Math.floor(i / 3)] ? s[i] / counts[k][Math.floor(i / 3)] : NaN;
    return out;
  });
  return { left, right, all };
}

export interface FacingCall {
  /** The side of the image the object's front is on. */
  front: SideEnd;
  /** Correlation (-1..1) behind the call: > 0 front on the left, < 0 on the right; near 0 it is a guess. */
  score: number;
}

/**
 * Which side of a side view shows the object's front: compares, band by band
 * down the object, how the view's left edge strip differs from its right one
 * with how the main photo differs from the back view.
 *
 * Seen from a side, an edge of the view is the middle of the front or of the
 * back, which the main photo and the back view show face-on: the front label's
 * dark band at a given height shows up on that edge of the side view, the back
 * label's barcode on the other. Without a back view the front is compared with
 * the side view's own average colours instead. Profiles are centred per colour
 * channel, so a side lit more strongly from one side does not decide it.
 */
export function sideFacing(side: EdgeProfiles, front: EdgeProfiles, back: EdgeProfiles | null): FacingCall {
  const a: number[][] = [[], [], []];
  const b: number[][] = [[], [], []];
  for (let i = 0; i < side.left.length; i++) {
    const f = (front.left[i] + front.right[i]) / 2;
    const other = back ? (back.left[i] + back.right[i]) / 2 : side.all[i];
    const d = side.left[i] - side.right[i];
    const e = f - other;
    if (Number.isNaN(d) || Number.isNaN(e)) continue;
    a[i % 3].push(d);
    b[i % 3].push(e);
  }
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let c = 0; c < 3; c++) {
    const n = a[c].length;
    if (!n) continue;
    const ma = a[c].reduce((s, v) => s + v, 0) / n;
    const mb = b[c].reduce((s, v) => s + v, 0) / n;
    for (let i = 0; i < n; i++) {
      ab += (a[c][i] - ma) * (b[c][i] - mb);
      aa += (a[c][i] - ma) ** 2;
      bb += (b[c][i] - mb) ** 2;
    }
  }
  const score = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  return { front: score >= 0 ? 'left' : 'right', score };
}

// ---------------------------------------------------------------------------
// Auto-pick

export type Slot = ViewName;

export interface AutoPicks {
  /** Candidate index per reference slot (the same one in both side slots when a symmetric object's only side view serves both). */
  slots: Partial<Record<Slot, number>>;
  /** Slots whose photo only sets the shape: a side view of which it is unknown which end it shows. */
  shapeOnly: Slot[];
  /** Side slots whose photo is to be mirrored: a symmetric object's side view facing the other way. */
  flip: Slot[];
}

export interface SymmetricSides {
  /** The object's outline is mirror-symmetric and its ends look alike (see isMirrorSymmetric). */
  symmetric: boolean;
  /** The side of a side view's image the object's front is on; `back` is the candidate picked for the back slot. Null if unknown. */
  frontOn?: (index: number, back: number | undefined) => SideEnd | null;
}

/** The slot a side view fits unmirrored: seen from the right (+x) the object's front is on the image's left, seen from the left on its right. */
const slotFacing = (front: SideEnd | null): 'left' | 'right' => (front === 'right' ? 'left' : 'right');

/**
 * Pick the best candidate for each reference slot: similar to the user's
 * object (same product) but showing a different side. Near-duplicates of the
 * input photo are skipped because they add no new information.
 *
 * Side views go to the left or right slot by `sideOf` (which end of the object
 * they show). When no side view can be placed:
 * - a mirror-symmetric object (`sym`) looks the same from either side, so its
 *   best side view textures the slot it faces and the next one (or the same one,
 *   mirrored) the other slot, each turned so the object's front is where that
 *   side's camera sees it;
 * - otherwise the best one still sets the object's depth, as shape only.
 */
export function autoAssign(scored: Scored[], mode: 'clip' | 'color', sideOf?: (index: number) => SideEnd | null, sym?: SymmetricSides): AutoPicks {
  const minSim = mode === 'clip' ? 0.6 : 0.45;
  const maxSim = mode === 'clip' ? 0.97 : 0.995;
  const minP = mode === 'clip' ? 0.3 : 0.5;
  const best = Math.max(0, ...scored.map((s) => s.similarity));
  const relFloor = best * (mode === 'clip' ? 0.85 : 0.75);
  const used = new Set<number>();
  const out: AutoPicks = { slots: {}, shapeOnly: [], flip: [] };
  const eligible = (view: CandidateView) =>
    scored
      .filter((s) => !used.has(s.index) && s.similarity >= minSim && s.similarity >= relFloor && s.similarity <= maxSim && s.probs[view] >= minP)
      .sort((a, b) => b.similarity * b.probs[view] - a.similarity * a.probs[view]);
  const take = (slot: Slot, index: number) => {
    out.slots[slot] = index;
    used.add(index);
  };
  const back = eligible('back')[0];
  if (back) take('back', back.index);
  const sides = eligible('side');
  for (const s of sides) {
    const end = sideOf?.(s.index) ?? null;
    if (end && out.slots[end] === undefined) take(end, s.index);
  }
  if (sides.length && out.slots.left === undefined && out.slots.right === undefined) {
    if (sym?.symmetric) {
      const facing = (index: number) => sym.frontOn?.(index, out.slots.back) ?? null;
      const [first, second] = sides;
      const slot = slotFacing(facing(first.index));
      const other = slot === 'right' ? 'left' : 'right';
      take(slot, first.index);
      if (second) {
        take(other, second.index);
        if (slotFacing(facing(second.index)) !== other) out.flip.push(other);
      } else {
        out.slots[other] = first.index;
        out.flip.push(other);
      }
    } else {
      take('right', sides[0].index);
      out.shapeOnly.push('right');
    }
  }
  const top = eligible('top')[0];
  if (top) take('top', top.index);
  return out;
}
