import { describe, expect, it } from 'vitest';
import { distanceTransform } from '../../src/core/distance';
import { reconstruct } from '../../src/core/reconstruct';
import { atlasLayout, bakeAtlas, type TextureRef } from '../../src/core/texture';
import { DEFAULT_SETTINGS, type ByteField, type RGBAImage } from '../../src/core/types';
import { disc, maskOf, paint, type RGB } from './helpers';

const DARK: RGB = [30, 30, 30];
const RED: RGB = [200, 30, 40];
const WHITE: RGB = [252, 252, 252];
const YELLOW: RGB = [245, 205, 60];
const BLUE: RGB = [30, 60, 220];

const settings = { ...DEFAULT_SETTINGS, resolution: 96, textureSize: 4096 };

function px(img: RGBAImage, x: number, y: number): RGB {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

function dist(a: RGB, b: RGB): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Distance (px) from every pixel of the cropped photo to the object's outline, from its non-backdrop pixels. */
function cropDistance(crop: RGBAImage): { inside: Uint8Array; d: Float32Array; out: Float32Array } {
  const n = crop.width * crop.height;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    inside[i] = dist(px(crop, i % crop.width, Math.floor(i / crop.width)), DARK) > 40 ? 1 : 0;
    outside[i] = 1 - inside[i];
  }
  return { inside, d: distanceTransform(inside, crop.width, crop.height).data, out: distanceTransform(outside, crop.width, crop.height).data };
}

describe('seam between the photo and the back', () => {
  // A red ball photographed with a bright rim light: a white band along the outline.
  const R = 70;
  const shape = disc(100, 100, R);
  const image = paint(200, 200, DARK, (x, y) => {
    if (!shape(x, y)) return null;
    return R - Math.hypot(x - 100, y - 100) < 6 ? WHITE : RED;
  });
  const res = reconstruct({ front: { image, mask: maskOf(200, 200, shape) }, refs: {}, settings });
  const crop = res.frontPhoto;
  const { inside, d, out } = cropDistance(crop);
  const backX = (res.atlas.width - 16) / 2 + 16;

  it('takes the seam colour from the interior, not from rim highlights', () => {
    let n = 0;
    const mean = [0, 0, 0];
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const i = y * crop.width + x;
        if (!inside[i] || d[i] > 2) continue;
        const c = px(res.atlas, x, y);
        for (let k = 0; k < 3; k++) mean[k] += c[k];
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
    const m = mean.map((v) => v / n) as RGB;
    // The outermost texels (what the model shows edge-on) carry the red of the ball.
    expect(dist(m, RED)).toBeLessThan(45);
  });

  it('removes the rim light where the photo sees the surface at a grazing angle', () => {
    let white = 0;
    let n = 0;
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i] || d[i] < 2 || d[i] > 5) continue;
      if (dist(px(res.atlas, i % crop.width, Math.floor(i / crop.width)), WHITE) < 60) white++;
      n++;
    }
    expect(n).toBeGreaterThan(200);
    expect(white / n).toBeLessThan(0.05);
  });

  it('keeps the photo exact away from the outline', () => {
    let checked = 0;
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const i = y * crop.width + x;
        if (!inside[i] || d[i] < 9) continue;
        expect(px(res.atlas, x, y)).toEqual(px(crop, x, y));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it('gives the outermost texels the same colour in both halves, so the side wall shows no line', () => {
    let n = 0;
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const i = y * crop.width + x;
        const atOutline = inside[i] ? d[i] < 1.5 : out[i] <= 2;
        if (!atOutline) continue;
        const f = px(res.atlas, x, y);
        const b = px(res.atlas, backX + x, y);
        for (let k = 0; k < 3; k++) expect(Math.abs(f[k] - b[k])).toBeLessThanOrEqual(1);
        n++;
      }
    }
    expect(n).toBeGreaterThan(400);
  });
});

describe('back tone without a back photo', () => {
  it('does not smear a small decal over the back', () => {
    const R = 80;
    const shape = disc(100, 100, R);
    const decal = (x: number, y: number) => Math.abs(x - 70) < 9 && Math.abs(y - 120) < 9;
    const image = paint(200, 200, DARK, (x, y) => (!shape(x, y) ? null : decal(x, y) ? BLUE : YELLOW));
    const res = reconstruct({ front: { image, mask: maskOf(200, 200, shape) }, refs: {}, settings });
    expect(res.stats.backTexture).toBe('tone');
    const crop = res.frontPhoto;
    const { inside, d } = cropDistance(crop);
    const backX = (res.atlas.width - 16) / 2 + 16;
    let worst = 0;
    for (let i = 0; i < inside.length; i++) {
      if (!inside[i] || d[i] < 10) continue;
      worst = Math.max(worst, dist(px(res.atlas, backX + (i % crop.width), Math.floor(i / crop.width)), YELLOW));
    }
    expect(worst).toBeLessThan(20);
  });
});

/**
 * Synthetic two-layer geometry on a 40 x 40 grid (4 texels per grid pixel),
 * every surface facing `normal`, photo uniformly yellow.
 */
function bakeSynthetic(
  inside: (i: number, j: number) => boolean,
  depth: (i: number, j: number) => [number, number],
  normal: [number, number, number],
  view: 'top' | 'right',
): RGBAImage {
  const G = 40;
  const S = 4;
  const T = G * S;
  const ins = new Uint8Array(G * G);
  const zF = new Float32Array(G * G);
  const zB = new Float32Array(G * G);
  const nf = new Float32Array(G * G * 3);
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const p = j * G + i;
      if (!inside(i, j)) continue;
      ins[p] = 1;
      [zB[p], zF[p]] = depth(i, j);
      nf.set(normal, p * 3);
    }
  }
  const mask: ByteField = { width: T, height: T, data: new Uint8Array(T * T) };
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) mask.data[y * T + x] = ins[Math.floor(y / S) * G + Math.floor(x / S)] ? 255 : 0;
  const photo = paint(T, T, YELLOW, () => YELLOW);
  const refImage = paint(64, 64, BLUE, () => BLUE);
  const full = { count: 64, first: 0, last: 63, lo: new Float32Array(64).fill(0), hi: new Float32Array(64).fill(63) };
  const ref: TextureRef = { image: refImage, rows: full, cols: full };
  return bakeAtlas({
    frontImage: photo,
    frontMask: mask,
    gridW: G,
    gridH: G,
    inside: ins,
    zF,
    zB,
    layout: atlasLayout(T, T, 4096),
    [view]: ref,
    backTexture: 'mirror',
    sideBlend: 1,
    normalF: nf,
    normalB: nf,
  });
}

/** Mean blue-ness (0 = photo yellow, 1 = reference blue) of the front half over a grid rectangle. */
function blueness(atlas: RGBAImage, i0: number, i1: number, j0: number, j1: number): number {
  let s = 0;
  let n = 0;
  for (let y = j0 * 4; y < (j1 + 1) * 4; y++) {
    for (let x = i0 * 4; x < (i1 + 1) * 4; x++) {
      const [, , b] = px(atlas, x, y);
      s += (b - YELLOW[2]) / (BLUE[2] - YELLOW[2]);
      n++;
    }
  }
  return s / n;
}

describe('side and top references', () => {
  it('paint only what the top photo can see', () => {
    // A thick upper block (z -16..16) overhangs a thinner lower block (z -8..8): from
    // above, the lower block's surfaces are hidden under the upper one.
    const atlas = bakeSynthetic(
      (i, j) => i >= 6 && i <= 33 && j >= 6 && j <= 33,
      (_i, j) => (j <= 15 ? [-16, 16] : [-8, 8]),
      [0, 1, 0],
      'top',
    );
    expect(blueness(atlas, 10, 29, 6, 7)).toBeGreaterThan(0.7);
    expect(blueness(atlas, 10, 29, 20, 33)).toBeLessThan(0.05);
  });

  it('paint only what a side photo can see', () => {
    // Seen from +x, the thin left block (z -8..8) is hidden behind the thick right one.
    const atlas = bakeSynthetic(
      (i, j) => i >= 6 && i <= 33 && j >= 6 && j <= 33,
      (i) => (i >= 20 ? [-16, 16] : [-8, 8]),
      [1, 0, 0],
      'right',
    );
    expect(blueness(atlas, 32, 33, 10, 29)).toBeGreaterThan(0.7);
    expect(blueness(atlas, 6, 15, 10, 29)).toBeLessThan(0.05);
  });
});
