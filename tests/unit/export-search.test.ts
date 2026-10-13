import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeOBJ, writeSTL } from '../../src/export/exporters';
import { createZip, crc32 } from '../../src/export/zip';
import { queryFromFilename, topLabels } from '../../src/search/identify';
import { segmentByColor } from '../../src/core/segment';
import type { RGBAImage } from '../../src/core/types';
import {
  autoAssign,
  colorSignature,
  frontEndColors,
  histogramSimilarity,
  hintOnlyProbs,
  MIN_END_CONTRAST,
  MIN_SIDE_MARGIN,
  objectColors,
  whichEnd,
  type Scored,
  type SideEnd,
} from '../../src/search/rank';
import { maskOf, paint, type RGB } from './helpers';

const tri = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};

describe('exporters', () => {
  it('writes OBJ with flipped v and 1-based faces', () => {
    const obj = writeOBJ(tri, 2);
    expect(obj).toContain('v 2.000000 0.000000 0.000000');
    expect(obj).toContain('vt 0.000000 0.000000');
    expect(obj).toContain('vt 0.000000 1.000000');
    expect(obj).toContain('f 1/1/1 2/2/2 3/3/3');
  });

  it('writes binary STL with facet normals', () => {
    const buf = Buffer.from(writeSTL(tri, 1000));
    expect(buf.readUInt32LE(80)).toBe(1);
    expect(buf.length).toBe(134);
    expect([buf.readFloatLE(84), buf.readFloatLE(88), buf.readFloatLE(92)]).toEqual([0, 0, 1]);
    expect(buf.readFloatLE(96 + 12)).toBe(1000);
  });

  it('builds zips that standard tools accept', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const zip = createZip([
      { name: 'model.obj', data: new TextEncoder().encode('o test\n') },
      { name: 'texture.jpg', data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-zip-')), 'out.zip');
    fs.writeFileSync(file, zip);
    const names = execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(z.namelist()))', file]).toString().trim();
    expect(names).toBe('model.obj,texture.jpg');
  });
});

describe('identification', () => {
  it.each([
    ['nike-air-max_90 (2).jpg', 'nike air max 90'],
    ['RedTeapotFront.png', 'red teapot'],
    ['IMG_2041.JPG', null],
    ['Screenshot 2026-01-02 at 10.11.12.png', null],
    ['3f2a9c1b7d8e4f60.webp', null],
    ['ceramic-vase.png', 'ceramic vase'],
    ['photo-of-blue-vase.jpg', 'blue vase'],
  ])('%s -> %s', (name, q) => expect(queryFromFilename(name)).toBe(q));

  it('ranks labels by similarity', () => {
    const img = new Float32Array([1, 0, 0]);
    const labels = [new Float32Array([0, 1, 0]), new Float32Array([0.99, 0.14, 0])];
    expect(topLabels(img, labels, ['cat', 'mug'], 1)[0].label).toBe('mug');
  });
});

describe('reference ranking', () => {
  const mk = (index: number, similarity: number, probs: Partial<Scored['probs']>): Scored => {
    const p = { front: 0, back: 0, side: 0, top: 0, ...probs };
    return { index, similarity, probs: p, view: 'front' };
  };

  it('picks the most similar photo of each hidden side and skips duplicates of the input', () => {
    const picks = autoAssign(
      [
        mk(0, 0.99, { front: 0.9 }), // same photo
        mk(1, 0.9, { back: 0.7, front: 0.3 }),
        mk(2, 0.88, { side: 0.8 }),
        mk(3, 0.5, { back: 0.9 }), // different object
        mk(4, 0.985, { back: 0.95 }), // near duplicate: skip
      ],
      'clip',
    );
    // Without knowing which end the side view shows, it only sets the shape.
    expect(picks).toEqual({ slots: { back: 1, right: 2 }, shapeOnly: ['right'] });
  });

  it('assigns nothing when no result is similar enough', () => {
    expect(autoAssign([mk(0, 0.4, { back: 0.9 })], 'clip')).toEqual({ slots: {}, shapeOnly: [] });
  });

  it('puts side views in the slot of the end they show', () => {
    const sides = [mk(0, 0.9, { side: 0.8 }), mk(1, 0.89, { side: 0.8 }), mk(2, 0.88, { side: 0.8 })];
    const ends = (...e: (SideEnd | null)[]) => (i: number) => e[i] ?? null;
    // Two views of different ends fill both slots, with texture.
    expect(autoAssign(sides, 'clip', ends('right', null, 'left'))).toEqual({ slots: { right: 0, left: 2 }, shapeOnly: [] });
    // A second view of an end that is already filled is not used for the other end.
    expect(autoAssign(sides, 'clip', ends('left', 'left', null))).toEqual({ slots: { left: 0 }, shapeOnly: [] });
    // Nothing placed: the best side view still sets the depth.
    expect(autoAssign(sides, 'clip', ends(null, null, null))).toEqual({ slots: { right: 0 }, shapeOnly: ['right'] });
  });

  it('uses colour similarity and query hints without AI', () => {
    const red = paint(64, 64, [250, 250, 250], (x, y) => (Math.hypot(x - 32, y - 32) < 20 ? [200, 30, 30] : null));
    const blue = paint(64, 64, [250, 250, 250], (x, y) => (Math.hypot(x - 32, y - 32) < 20 ? [30, 30, 200] : null));
    const s = colorSignature(red);
    expect(histogramSimilarity(s, colorSignature(red))).toBeCloseTo(1, 5);
    expect(histogramSimilarity(s, colorSignature(blue))).toBeLessThan(0.2);
    expect(hintOnlyProbs('back').back).toBeGreaterThan(0.6);
  });
});

describe('which end of the object a side view shows', () => {
  const BG: RGB = [236, 234, 230];
  const YELLOW: RGB = [245, 205, 40];
  const ORANGE: RGB = [240, 120, 25];
  const DARK: RGB = [30, 30, 35];
  const RED: RGB = [140, 25, 20];
  const CREAM: RGB = [235, 215, 160];
  const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

  // A duck-like toy in profile: an orange beak and dark eye at its left (-x) end, a plain yellow tail at the right.
  const duckShape = (x: number, y: number): RGB | null => {
    if (x >= 14 && x < 30 && y >= 44 && y < 54) return ORANGE;
    if (inEllipse(x, y, 40, 38, 3, 3)) return DARK;
    if (inEllipse(x, y, 42, 44, 14, 14) || inEllipse(x, y, 66, 76, 46, 28)) return YELLOW;
    return null;
  };
  const front = paint(128, 128, BG, duckShape);
  const frontMask = maskOf(128, 128, (x, y) => duckShape(x, y) !== null);
  // Head-on (camera at -x): a round yellow body, the head, and the beak pointing at the camera.
  const headOn = (bg: RGB) =>
    paint(96, 96, bg, (x, y) => {
      if (inEllipse(x, y, 48, 44, 14, 7)) return ORANGE;
      if (inEllipse(x, y, 38, 32, 3, 3) || inEllipse(x, y, 58, 32, 3, 3)) return DARK;
      if (inEllipse(x, y, 48, 38, 18, 16) || inEllipse(x, y, 48, 66, 32, 22)) return YELLOW;
      return null;
    });
  // From behind (camera at +x): only the yellow tail and back of the head.
  const tailOn = (bg: RGB) => paint(96, 96, bg, (x, y) => (inEllipse(x, y, 48, 38, 18, 16) || inEllipse(x, y, 48, 66, 32, 22) ? YELLOW : null));
  const cutOut = (img: RGBAImage) => {
    const seg = segmentByColor(img, { tolerance: 16, enclosedHoles: true, workSize: 256 });
    expect(seg.method).toBe('color-key');
    return objectColors(img, seg.mask);
  };

  it('tells the beak end from the tail end', () => {
    const ends = frontEndColors(front, frontMask)!;
    expect(ends).not.toBeNull();
    const a = whichEnd(cutOut(headOn(BG)), ends);
    const b = whichEnd(cutOut(tailOn(BG)), ends);
    expect(a.end).toBe('left');
    expect(b.end).toBe('right');
    // With room to spare.
    expect(a.margin).toBeGreaterThan(2 * MIN_SIDE_MARGIN);
    expect(b.margin).toBeLessThan(-2 * MIN_SIDE_MARGIN);
  });

  it('falls back to the central region, minus white backdrop, when a photo cannot be cut out', () => {
    const ends = frontEndColors(front, frontMask)!;
    const WHITE: RGB = [252, 252, 252];
    expect(whichEnd(objectColors(headOn(WHITE), null), ends).end).toBe('left');
    expect(whichEnd(objectColors(tailOn(WHITE), null), ends).end).toBe('right');
  });

  it('tells an orange end from a yellow end', () => {
    const bar = (x: number, y: number): RGB | null => (x >= 10 && x < 118 && y >= 40 && y < 88 ? (x < 40 ? ORANGE : YELLOW) : null);
    const ends = frontEndColors(paint(128, 128, BG, bar), maskOf(128, 128, (x, y) => bar(x, y) !== null))!;
    const end = (c: RGB) => whichEnd(cutOut(paint(64, 64, BG, (x, y) => (inEllipse(x, y, 32, 32, 18, 22) ? c : null))), ends);
    expect(end(ORANGE).end).toBe('left');
    expect(end(YELLOW).end).toBe('right');
  });

  it('tells the ends apart when each has a colour of its own and the views are mostly body colour', () => {
    const BLUE: RGB = [40, 80, 210];
    const toy = (x: number, y: number): RGB | null => {
      if (inEllipse(x, y, 23, 64, 10, 8)) return ORANGE;
      if (inEllipse(x, y, 105, 61, 10, 13)) return BLUE;
      return inEllipse(x, y, 64, 67, 46, 26) ? YELLOW : null;
    };
    const ends = frontEndColors(paint(128, 128, BG, toy), maskOf(128, 128, (x, y) => toy(x, y) !== null))!;
    // Each end seen face-on: mostly yellow body around a small nose or tail.
    const endOn = (c: RGB) => paint(96, 96, BG, (x, y) => (inEllipse(x, y, 48, 48, 10, 8) ? c : inEllipse(x, y, 48, 50, 29, 21) ? YELLOW : null));
    expect(whichEnd(cutOut(endOn(ORANGE)), ends).end).toBe('left');
    expect(whichEnd(cutOut(endOn(BLUE)), ends).end).toBe('right');
  });

  it('gives no end when both ends look alike', () => {
    // A plain bottle: red glass with a cream label across the middle; both ends are red glass.
    const bottle = (x: number, y: number): RGB | null => {
      if (x < 34 || x >= 94 || y < 20 || y >= 116) return null;
      return y > 50 && y < 90 && x > 44 && x < 84 ? CREAM : RED;
    };
    const ends = frontEndColors(paint(128, 128, BG, bottle), maskOf(128, 128, (x, y) => bottle(x, y) !== null))!;
    const side = paint(96, 96, BG, (x, y) => (x >= 33 && x < 63 && y >= 14 && y < 86 ? (y > 38 && y < 64 && (x < 38 || x > 58) ? CREAM : RED) : null));
    const call = whichEnd(cutOut(side), ends);
    expect(call.contrast).toBeLessThan(MIN_END_CONTRAST);
    expect(call.end).toBeNull();
  });

  it('gives no end when a view resembles neither end', () => {
    const ends = frontEndColors(front, frontMask)!;
    const blue = paint(96, 96, BG, (x, y) => (inEllipse(x, y, 48, 48, 30, 30) ? [30, 60, 200] : null));
    expect(whichEnd(cutOut(blue), ends).end).toBeNull();
  });
});
