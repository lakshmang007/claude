import { describe, expect, it } from 'vitest';
import { distanceTransform } from '../../src/core/distance';
import { pushPull } from '../../src/core/imageops';
import { reconstruct } from '../../src/core/reconstruct';
import { segmentByColor } from '../../src/core/segment';
import { detectCaps } from '../../src/core/shape';
import { DEFAULT_SETTINGS, type ReconstructSettings, type ViewInput } from '../../src/core/types';
import { bounds, disc, fieldOf, iou, maskOf, paint, signedVolume, type RGB } from './helpers';

const WHITE: RGB = [245, 245, 245];
const RED: RGB = [200, 30, 40];
const BLUE: RGB = [30, 60, 210];

function settings(over: Partial<ReconstructSettings> = {}): ReconstructSettings {
  return { ...DEFAULT_SETTINGS, resolution: 96, textureSize: 1024, ...over };
}

describe('distance transform', () => {
  it('matches brute force on a random mask', () => {
    const w = 23, h = 17;
    const inside = new Uint8Array(w * h);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < inside.length; i++) inside[i] = rnd() > 0.25 ? 1 : 0;
    const d = distanceTransform(inside, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inside[y * w + x]) {
          expect(d.data[y * w + x]).toBe(0);
          continue;
        }
        let best = Infinity;
        // Outside the raster counts as background (padding ring at -1 and w/h).
        for (let yy = -1; yy <= h; yy++) {
          for (let xx = -1; xx <= w; xx++) {
            const out = xx < 0 || yy < 0 || xx >= w || yy >= h || !inside[yy * w + xx];
            if (out) best = Math.min(best, Math.hypot(xx - x, yy - y));
          }
        }
        expect(d.data[y * w + x]).toBeCloseTo(best, 4);
      }
    }
  });
});

describe('push-pull fill', () => {
  it('keeps known values and fills unknown ones in range', () => {
    const w = 16, h = 16;
    const vals = new Float32Array(w * h);
    const wts = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      vals[x] = 10;
      wts[x] = 1;
      vals[(h - 1) * w + x] = 20;
      wts[(h - 1) * w + x] = 1;
    }
    const out = pushPull(vals, wts, w, h, 1);
    expect(out[3]).toBe(10);
    expect(out[(h - 1) * w + 3]).toBe(20);
    const mid = out[8 * w + 8];
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(20);
  });
});

describe('colour-key segmentation', () => {
  it('cuts a disc out of a plain backdrop', () => {
    const shape = disc(80, 60, 40);
    const img = paint(160, 120, WHITE, (x, y) => (shape(x, y) ? RED : null));
    const res = segmentByColor(img);
    expect(res.method).toBe('color-key');
    expect(res.confidence).toBeGreaterThan(0.95);
    expect(iou(res.mask, maskOf(160, 120, shape))).toBeGreaterThan(0.96);
  });

  it('removes backdrop seen through an enclosed hole', () => {
    const outer = disc(80, 80, 60);
    const inner = disc(80, 80, 25);
    const ring = (x: number, y: number) => outer(x, y) && !inner(x, y);
    const img = paint(160, 160, WHITE, (x, y) => (ring(x, y) ? BLUE : null));
    const res = segmentByColor(img);
    expect(res.mask.data[80 * 160 + 80]).toBeLessThan(128);
    expect(iou(res.mask, maskOf(160, 160, ring))).toBeGreaterThan(0.95);
  });

  it('keeps an object whose colour matches nothing in the border', () => {
    // Two-tone object with an inner patch close to the backdrop colour but not reachable from the border.
    const body = disc(60, 60, 45);
    const patch = disc(60, 60, 4);
    const img = paint(120, 120, WHITE, (x, y) => (patch(x, y) ? [235, 235, 235] : body(x, y) ? RED : null));
    const res = segmentByColor(img);
    // A small enclosed highlight (below the hole area threshold) stays part of the object.
    expect(res.mask.data[60 * 120 + 60]).toBeGreaterThanOrEqual(128);
  });
});

function frontView(w: number, h: number, shape: (x: number, y: number) => boolean, color: RGB | ((x: number, y: number) => RGB), depth?: (x: number, y: number) => number): ViewInput {
  const col = typeof color === 'function' ? color : () => color;
  return {
    image: paint(w, h, WHITE, (x, y) => (shape(x, y) ? col(x, y) : null)),
    mask: maskOf(w, h, shape),
    depth: depth ? fieldOf(w, h, depth) : undefined,
  };
}

describe('reconstruction', () => {
  it('turns a disc into a closed, outward-facing ball without a depth model', () => {
    const shape = disc(100, 100, 80);
    const res = reconstruct({ front: frontView(200, 200, shape, RED), refs: {}, settings: settings() });
    expect(res.stats.watertight).toBe(true);
    expect(res.stats.usedDepth).toBe(false);
    expect(res.stats.backShape).toBe('round');
    expect(signedVolume(res.positions, res.indices)).toBeGreaterThan(0);
    const b = bounds(res.positions);
    // A sphere: depth ≈ width.
    expect(b.size[2] / b.size[0]).toBeGreaterThan(0.85);
    expect(b.size[2] / b.size[0]).toBeLessThan(1.1);
    // Grounded on y = 0.
    expect(b.min[1]).toBeCloseTo(0, 6);
  });

  it('keeps through-holes open and stays watertight', () => {
    const outer = disc(100, 100, 80);
    const inner = disc(100, 100, 30);
    const ring = (x: number, y: number) => outer(x, y) && !inner(x, y);
    const res = reconstruct({ front: frontView(200, 200, ring, BLUE), refs: {}, settings: settings() });
    expect(res.stats.watertight).toBe(true);
    // No vertex in the hole.
    const unit = 1 / res.stats.gridHeight;
    for (let i = 0; i < res.positions.length; i += 3) {
      const x = res.positions[i];
      const y = res.positions[i + 1] - (res.frame.top + res.frame.bottom) / 2;
      expect(Math.hypot(x, y)).toBeGreaterThan(30 / 168 - 2 * unit);
    }
  });

  it('uses the depth map for relief and mirrors it to the back', () => {
    const shape = disc(100, 100, 80);
    // A bump on the left half only.
    const depth = (x: number, y: number) => (Math.hypot(x - 70, y - 100) < 30 ? 1 : 0.2);
    const res = reconstruct({ front: frontView(200, 200, shape, RED, depth), refs: {}, settings: settings({ roundness: 0 }) });
    expect(res.stats.usedDepth).toBe(true);
    expect(res.stats.backShape).toBe('mirror');
    expect(res.stats.watertight).toBe(true);
    // Front z on the bump is higher than on the right half.
    const centerY = (res.frame.top + res.frame.bottom) / 2;
    const zAt = (wx: number) => {
      let best = -Infinity;
      for (let i = 0; i < res.positions.length; i += 3) {
        if (Math.abs(res.positions[i] - wx) < 0.02 && Math.abs(res.positions[i + 1] - centerY) < 0.05) {
          best = Math.max(best, res.positions[i + 2]);
        }
      }
      return best;
    };
    expect(zAt(-30 / 168)).toBeGreaterThan(zAt(30 / 168));
  });

  it('projects the photo onto the front unchanged', () => {
    const shape = disc(100, 80, 70);
    const color = (x: number, y: number): RGB => [Math.round(x), Math.round(y), (Math.round(x * y) % 200) + 20];
    const front = frontView(200, 160, shape, color);
    const res = reconstruct({ front, refs: {}, settings: settings({ textureSize: 4096 }) });
    const crop = res.frontPhoto;
    const atlas = res.atlas;
    // The crop is not resized (atlas big enough), so interior texels must equal the photo.
    let checked = 0;
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const o = (y * crop.width + x) * 4;
        // Only interior pixels: the rim is cleaned of background bleed on purpose.
        const cx = x - crop.width / 2, cy = y - crop.height / 2;
        if (Math.hypot(cx, cy) > 65) continue;
        const a = (y * atlas.width + x) * 4;
        expect([atlas.data[a], atlas.data[a + 1], atlas.data[a + 2]]).toEqual([crop.data[o], crop.data[o + 1], crop.data[o + 2]]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it('takes the back texture from a back reference photo', () => {
    const shape = disc(100, 100, 80);
    const back: ViewInput = frontView(300, 260, disc(150, 130, 110), BLUE);
    const res = reconstruct({ front: frontView(200, 200, shape, RED), refs: { back }, settings: settings() });
    expect(res.stats.backTexture).toBe('reference');
    expect(res.stats.usedRefs).toContain('back');
    const { atlas } = res;
    const half = (atlas.width - 16) / 2;
    const cx = Math.round(half + 16 + half / 2);
    const o = (Math.round(atlas.height / 2) * atlas.width + cx) * 4;
    expect(atlas.data[o + 2]).toBeGreaterThan(150);
    expect(atlas.data[o]).toBeLessThan(80);
  });

  it('matches the depth seen in a side reference', () => {
    const shape = disc(100, 100, 80);
    // Side view: same height, but only half as deep -> a squashed ellipse.
    const ellipse = (x: number, y: number) => ((x - 100) / 40) ** 2 + ((y - 100) / 80) ** 2 <= 1;
    const side: ViewInput = frontView(200, 200, ellipse, RED);
    const plain = reconstruct({ front: frontView(200, 200, shape, RED), refs: {}, settings: settings() });
    const res = reconstruct({ front: frontView(200, 200, shape, RED), refs: { right: side }, settings: settings() });
    expect(res.stats.watertight).toBe(true);
    const ratio = bounds(res.positions).size[2] / bounds(res.positions).size[0];
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.62);
    expect(bounds(plain.positions).size[2]).toBeGreaterThan(bounds(res.positions).size[2] * 1.5);
  });

  it('gives long shapes round (not egg-shaped) cross-sections', () => {
    // A horizontal bar 300 x 60 px: depth should be about its height, as for a cylinder.
    const bar = (x: number, y: number) => x > 50 && x < 350 && y > 70 && y < 130;
    const res = reconstruct({ front: frontView(400, 200, bar, BLUE), refs: {}, settings: settings({ resolution: 160 }) });
    const b = bounds(res.positions);
    expect(b.size[2] / b.size[1]).toBeGreaterThan(0.85);
    expect(b.size[2] / b.size[1]).toBeLessThan(1.15);
  });

  it('snaps the outline to the cut-out with sub-pixel accuracy', () => {
    const R = 80;
    const res = reconstruct({ front: frontView(200, 200, disc(100, 100, R), RED), refs: {}, settings: settings({ resolution: 64 }) });
    // Grid pixels are ~2.6 image px here, yet the rim (side-wall vertices, normal.z = 0) must sit on the circle.
    const cy = (res.frame.top + res.frame.bottom) / 2;
    const cropH = res.frontPhoto.height;
    let rim = 0;
    let worst = 0;
    for (let v = 0; v < res.normals.length; v += 3) {
      if (res.normals[v + 2] !== 0) continue;
      const r = Math.hypot(res.positions[v], res.positions[v + 1] - cy) * cropH;
      worst = Math.max(worst, Math.abs(r - R));
      rim++;
    }
    expect(rim).toBeGreaterThan(100);
    expect(worst).toBeLessThan(0.75);
  });

  it('produces unit normals facing outwards', () => {
    const res = reconstruct({ front: frontView(200, 200, disc(100, 100, 80), RED), refs: {}, settings: settings() });
    const cy = (res.frame.top + res.frame.bottom) / 2;
    let cz = 0;
    for (let i = 2; i < res.positions.length; i += 3) cz += res.positions[i];
    cz /= res.positions.length / 3;
    for (let v = 0; v < res.normals.length; v += 3) {
      const n = [res.normals[v], res.normals[v + 1], res.normals[v + 2]];
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 4);
      const d = [res.positions[v], res.positions[v + 1] - cy, res.positions[v + 2] - cz];
      // On a ball every normal points away from the centre.
      expect(n[0] * d[0] + n[1] * d[1] + n[2] * d[2]).toBeGreaterThan(0);
    }
  });

  it('gives an upright cylinder a flat base and a flat top', () => {
    // 120 x 300 px, the top shoulders rounded (radius 20).
    const can = (x: number, y: number) => {
      if (x < 40 || x > 160 || y < 50 || y > 350) return false;
      const cx = x < 60 ? 60 : x > 140 ? 140 : x;
      return y >= 70 || Math.hypot(x - cx, y - 70) <= 20;
    };
    const res = reconstruct({ front: frontView(200, 400, can, BLUE), refs: {}, settings: settings() });
    expect(res.stats.watertight).toBe(true);
    expect(signedVolume(res.positions, res.indices)).toBeGreaterThan(0);
    const b = bounds(res.positions);
    // Still a round cross-section: as deep as it is wide.
    expect(b.size[2] / b.size[0]).toBeGreaterThan(0.85);
    expect(b.size[2] / b.size[0]).toBeLessThan(1.15);
    const unit = 1 / res.stats.gridHeight;
    // The bottom ring of vertices spans the whole depth (a disc), not a ridge.
    let zMin = Infinity, zMax = -Infinity;
    for (let v = 0; v < res.positions.length; v += 3) {
      if (res.positions[v + 1] > b.min[1] + 0.25 * unit) continue;
      zMin = Math.min(zMin, res.positions[v + 2]);
      zMax = Math.max(zMax, res.positions[v + 2]);
    }
    expect((zMax - zMin) / b.size[2]).toBeGreaterThan(0.9);
    // Faces lying in the base face straight down, and so do their vertex normals
    // (apart from slivers at the corners, where the base meets the side).
    let area = 0, down = 0, smooth = 0;
    const P = res.positions, N = res.normals;
    for (let t = 0; t < res.indices.length; t += 3) {
      const [a, c, d] = [res.indices[t] * 3, res.indices[t + 1] * 3, res.indices[t + 2] * 3];
      if (Math.max(P[a + 1], P[c + 1], P[d + 1]) > b.min[1] + 0.25 * unit) continue;
      const e1 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const e2 = [P[d] - P[a], P[d + 1] - P[a + 1], P[d + 2] - P[a + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len < 1e-12) continue;
      area += len;
      down += -n[1];
      if (Math.max(N[a + 1], N[c + 1], N[d + 1]) < -0.9) smooth += len;
    }
    expect(down / area).toBeGreaterThan(0.95);
    expect(smooth / area).toBeGreaterThan(0.95);
    // The base disc is about as wide as the object (nearly the whole bottom outline is flat).
    expect(area / 2 / (Math.PI * (b.size[0] / 2) * (b.size[2] / 2))).toBeGreaterThan(0.75);
    // The flat top between the shoulders is a cap too, the rounded shoulders are not.
    let topDepth = 0;
    for (let v = 0; v < res.positions.length; v += 3) {
      if (res.positions[v + 1] < b.max[1] - 0.25 * unit) continue;
      topDepth = Math.max(topDepth, Math.abs(res.positions[v + 2]));
    }
    expect((2 * topDepth) / b.size[2]).toBeGreaterThan(0.5);
  });

  it('keeps a flat base full depth when the depth map bleeds into the backdrop there', () => {
    const can = (x: number, y: number) => x > 40 && x < 160 && y > 50 && y < 350;
    // Round relief that fades to the backdrop over the bottom 5 px, as a depth network's would.
    const depth = (x: number, y: number) => (can(x, y) ? 0.2 + 0.8 * Math.sqrt(Math.max(0, 1 - ((x - 100) / 60) ** 2)) * Math.min(1, (350 - y) / 5) : 0);
    const res = reconstruct({ front: frontView(200, 400, can, BLUE, depth), refs: {}, settings: settings({ resolution: 128 }) });
    expect(res.stats.usedDepth).toBe(true);
    expect(res.stats.watertight).toBe(true);
    const b = bounds(res.positions);
    const unit = 1 / res.stats.gridHeight;
    const depthAt = (y0: number) => {
      let lo = Infinity, hi = -Infinity;
      for (let v = 0; v < res.positions.length; v += 3) {
        if (Math.abs(res.positions[v + 1] - y0) > 0.5 * unit) continue;
        lo = Math.min(lo, res.positions[v + 2]);
        hi = Math.max(hi, res.positions[v + 2]);
      }
      return hi - lo;
    };
    expect(depthAt(b.min[1]) / depthAt(b.min[1] + b.size[1] / 2)).toBeGreaterThan(0.9);
  });

  it('finds flat ends only where walls rise from a straight or shallow outline', () => {
    const at = (w: number, h: number, shape: (x: number, y: number) => boolean, res: number) => {
      const mask = maskOf(w, h, shape);
      const g = res / Math.max(w, h);
      const W = Math.round(w * g), H = Math.round(h * g);
      const small = maskOf(W, H, (x, y) => shape(x / g, y / g));
      const inside = Uint8Array.from(small.data, (v) => (v >= 128 ? 1 : 0));
      return detectCaps(inside, W, H, mask).map((c) => c.side).sort();
    };
    expect(at(200, 200, disc(100, 100, 80), 128)).toEqual([]);
    expect(at(200, 200, disc(100, 100, 20), 256)).toEqual([]);
    // A lying bar's long edges are rims of a cylinder, not flat ends.
    expect(at(400, 200, (x, y) => x > 50 && x < 350 && y > 70 && y < 130, 160)).toEqual([]);
    expect(at(400, 200, (x, y) => ((x - 200) / 150) ** 2 + ((y - 100) / 40) ** 2 <= 1, 160)).toEqual([]);
    expect(at(200, 400, (x, y) => ((x - 100) / 60) ** 2 + ((y - 200) / 150) ** 2 <= 1, 160)).toEqual([]);
    expect(at(200, 400, (x, y) => x > 40 && x < 160 && y > 50 && y < 350, 128)).toEqual(['bottom', 'top']);
    // A can seen from a little above: its base outline is half an ellipse.
    const persp = (x: number, y: number) => Math.abs(x - 100) <= 60 && y >= 60 && (y <= 330 || ((x - 100) / 60) ** 2 + ((y - 330) / 14) ** 2 <= 1);
    expect(at(200, 400, persp, 128)).toEqual(['bottom', 'top']);
  });

  it('uses geometry-only references for thickness but not for texture', () => {
    const shape = disc(100, 100, 80);
    const ellipse = (x: number, y: number) => ((x - 100) / 40) ** 2 + ((y - 100) / 80) ** 2 <= 1;
    const side: ViewInput = { ...frontView(200, 200, ellipse, BLUE), geometryOnly: true };
    const back: ViewInput = { ...frontView(300, 260, disc(150, 130, 110), BLUE), geometryOnly: true };
    const res = reconstruct({ front: frontView(200, 200, shape, RED), refs: { right: side, back }, settings: settings() });
    expect(res.stats.usedRefs).toEqual([]);
    expect(res.stats.shapeOnlyRefs.sort()).toEqual(['back', 'right']);
    expect(res.stats.backTexture).toBe('tone');
    const ratio = bounds(res.positions).size[2] / bounds(res.positions).size[0];
    expect(ratio).toBeLessThan(0.62);
    // No blue from the references anywhere in the atlas.
    let blue = 0;
    for (let i = 0; i < res.atlas.data.length; i += 4) if (res.atlas.data[i + 2] > 150 && res.atlas.data[i] < 80) blue++;
    expect(blue).toBe(0);
  });

  it('rejects an empty mask', () => {
    const view = frontView(50, 50, () => false, RED);
    expect(() => reconstruct({ front: view, refs: {}, settings: settings() })).toThrow(/empty/);
  });
});
