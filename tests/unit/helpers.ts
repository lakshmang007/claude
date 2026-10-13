import type { ByteField, FloatField, RGBAImage } from '../../src/core/types';

export type RGB = [number, number, number];

/** Paint an image where `shape(x, y)` returns a colour for object pixels or null for background. */
export function paint(width: number, height: number, bg: RGB, shape: (x: number, y: number) => RGB | null): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = shape(x + 0.5, y + 0.5) ?? bg;
      const o = (y * width + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

export function maskOf(width: number, height: number, inside: (x: number, y: number) => boolean): ByteField {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = inside(x + 0.5, y + 0.5) ? 255 : 0;
  return { width, height, data };
}

export function fieldOf(width: number, height: number, f: (x: number, y: number) => number): FloatField {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = f(x + 0.5, y + 0.5);
  return { width, height, data };
}

export const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

export function iou(a: ByteField, b: ByteField): number {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.data.length; i++) {
    const p = a.data[i] >= 128;
    const q = b.data[i] >= 128;
    if (p && q) inter++;
    if (p || q) uni++;
  }
  return uni ? inter / uni : 1;
}

/** Axis-aligned bounds of a position buffer. */
export function bounds(pos: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  }
  return { min, max, size: max.map((v, k) => v - min[k]) };
}

/** Signed volume of a closed triangle mesh (positive when outward-facing). */
export function signedVolume(pos: Float32Array, idx: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v +=
      (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
        pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) /
      6;
  }
  return v;
}
