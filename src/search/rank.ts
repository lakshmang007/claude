import type { RGBAImage } from '../core/types';

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

export type Slot = 'back' | 'right' | 'top';

/**
 * Pick the best candidate for each reference slot: similar to the user's
 * object (same product) but showing a different side. Near-duplicates of the
 * input photo are skipped because they add no new information.
 */
export function autoAssign(scored: Scored[], mode: 'clip' | 'color'): Partial<Record<Slot, number>> {
  const minSim = mode === 'clip' ? 0.6 : 0.45;
  const maxSim = mode === 'clip' ? 0.97 : 0.995;
  const minP = mode === 'clip' ? 0.3 : 0.5;
  const best = Math.max(0, ...scored.map((s) => s.similarity));
  const relFloor = best * (mode === 'clip' ? 0.85 : 0.75);
  const slotView: Record<Slot, CandidateView> = { back: 'back', right: 'side', top: 'top' };
  const used = new Set<number>();
  const out: Partial<Record<Slot, number>> = {};
  for (const slot of ['back', 'right', 'top'] as Slot[]) {
    const view = slotView[slot];
    let pick = -1;
    let pickScore = 0;
    for (const s of scored) {
      if (used.has(s.index)) continue;
      if (s.similarity < minSim || s.similarity < relFloor || s.similarity > maxSim) continue;
      if (s.probs[view] < minP) continue;
      const score = s.similarity * s.probs[view];
      if (score > pickScore) {
        pickScore = score;
        pick = s.index;
      }
    }
    if (pick >= 0) {
      out[slot] = pick;
      used.add(pick);
    }
  }
  return out;
}
