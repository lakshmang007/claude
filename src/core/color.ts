import { clamp } from './imageops';
import type { ByteField, RGBAImage } from './types';

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function fLab(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function fLabInv(t: number): number {
  const t3 = t * t * t;
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clamp(Math.round(v * 255), 0, 255);
}

/** sRGB bytes -> CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const lr = SRGB_TO_LINEAR[r];
  const lg = SRGB_TO_LINEAR[g];
  const lb = SRGB_TO_LINEAR[b];
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

export function labToRgb(L: number, a: number, b: number, out: Uint8ClampedArray | number[], o = 0): void {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = fLabInv(fx) * 0.95047;
  const y = fLabInv(fy);
  const z = fLabInv(fz) * 1.08883;
  const lr = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const lg = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const lb = x * 0.0557 + y * -0.204 + z * 1.057;
  out[o] = linearToSrgb(clamp(lr, 0, 1));
  out[o + 1] = linearToSrgb(clamp(lg, 0, 1));
  out[o + 2] = linearToSrgb(clamp(lb, 0, 1));
}

export function imageToLab(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgbToLab(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2], lab, i * 3);
  return lab;
}

interface LabStats {
  mean: [number, number, number];
  std: [number, number, number];
}

function labStats(lab: Float32Array, mask: ByteField): LabStats | null {
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] < 200) continue;
    for (let c = 0; c < 3; c++) {
      const v = lab[i * 3 + c];
      sum[c] += v;
      sq[c] += v * v;
    }
    n++;
  }
  if (n < 16) return null;
  const mean = sum.map((s) => s / n) as [number, number, number];
  const std = sq.map((s, c) => Math.sqrt(Math.max(1e-6, s / n - mean[c] * mean[c]))) as [number, number, number];
  return { mean, std };
}

/**
 * Gentle Reinhard-style colour transfer in Lab: move the lightness statistics
 * of `src` (inside its mask) towards `target` and nudge its white balance.
 * `strength` 0..1. Corrects exposure / white-balance differences between web
 * references and the user's photo without repainting them.
 */
export function matchColors(src: RGBAImage, srcMask: ByteField, target: RGBAImage, targetMask: ByteField, strength: number): RGBAImage {
  if (strength <= 0) return src;
  const srcLab = imageToLab(src);
  const s = labStats(srcLab, srcMask);
  const t = labStats(imageToLab(target), targetMask);
  if (!s || !t) return src;
  const out: RGBAImage = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  // Only correct exposure and white balance: lightness is matched (bounded), chroma is
  // shifted by at most a few units so a genuinely different-coloured back stays that colour.
  const lRatio = clamp(t.std[0] / s.std[0], 0.75, 1.33);
  const lShift = clamp(t.mean[0] - s.mean[0], -15, 15);
  const aShift = clamp(t.mean[1] - s.mean[1], -6, 6);
  const bShift = clamp(t.mean[2] - s.mean[2], -6, 6);
  const px = [0, 0, 0];
  for (let i = 0, n = src.width * src.height; i < n; i++) {
    const L = srcLab[i * 3];
    const A = srcLab[i * 3 + 1];
    const B = srcLab[i * 3 + 2];
    const tl = (L - s.mean[0]) * lRatio + s.mean[0] + lShift;
    labToRgb(L + (tl - L) * strength, A + aShift * strength, B + bShift * strength, px);
    out.data[i * 4] = px[0];
    out.data[i * 4 + 1] = px[1];
    out.data[i * 4 + 2] = px[2];
  }
  return out;
}
