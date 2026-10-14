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
  edgeProfiles,
  frontEndColors,
  histogramSimilarity,
  hintOnlyProbs,
  isMirrorSymmetric,
  MIN_END_CONTRAST,
  MIN_MIRROR_IOU,
  MIN_SIDE_MARGIN,
  mirrorSymmetry,
  objectColors,
  sideFacing,
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
    expect(picks).toEqual({ slots: { back: 1, right: 2 }, shapeOnly: ['right'], flip: [] });
  });

  it('assigns nothing when no result is similar enough', () => {
    expect(autoAssign([mk(0, 0.4, { back: 0.9 })], 'clip')).toEqual({ slots: {}, shapeOnly: [], flip: [] });
  });

  it('puts side views in the slot of the end they show', () => {
    const sides = [mk(0, 0.9, { side: 0.8 }), mk(1, 0.89, { side: 0.8 }), mk(2, 0.88, { side: 0.8 })];
    const ends = (...e: (SideEnd | null)[]) => (i: number) => e[i] ?? null;
    // Two views of different ends fill both slots, with texture.
    expect(autoAssign(sides, 'clip', ends('right', null, 'left'))).toEqual({ slots: { right: 0, left: 2 }, shapeOnly: [], flip: [] });
    // A second view of an end that is already filled is not used for the other end.
    expect(autoAssign(sides, 'clip', ends('left', 'left', null))).toEqual({ slots: { left: 0 }, shapeOnly: [], flip: [] });
    // Nothing placed: the best side view still sets the depth.
    expect(autoAssign(sides, 'clip', ends(null, null, null))).toEqual({ slots: { right: 0 }, shapeOnly: ['right'], flip: [] });
    // An asymmetric object (a mug and its handle) stays that way, whichever way its side views face.
    const facing = () => 'right' as const;
    expect(autoAssign(sides, 'clip', ends(null, null, null), { symmetric: false, frontOn: facing })).toEqual({ slots: { right: 0 }, shapeOnly: ['right'], flip: [] });
  });

  it('textures both sides of a mirror-symmetric object, each side view turned the way its slot sees the object', () => {
    const back = mk(0, 0.92, { back: 0.8 });
    const sides = [mk(1, 0.9, { side: 0.8 }), mk(2, 0.89, { side: 0.8 }), mk(3, 0.88, { side: 0.8 })];
    const none = () => null;
    // Which side of each image the object's front is on; it is told which candidate went to the back slot.
    const seenBack: (number | undefined)[] = [];
    const facing = (...f: SideEnd[]) => (i: number, b: number | undefined) => {
      seenBack.push(b);
      return f[i - 1] ?? null;
    };
    // Front on the image's left is how the right (+x) side is seen, front on its right the left side: no mirroring needed.
    expect(autoAssign([back, ...sides], 'clip', none, { symmetric: true, frontOn: facing('right', 'left') })).toEqual({
      slots: { back: 0, left: 1, right: 2 },
      shapeOnly: [],
      flip: [],
    });
    expect(seenBack.every((b) => b === 0)).toBe(true);
    // Both face the same way: the second is mirrored for the other side.
    expect(autoAssign(sides, 'clip', none, { symmetric: true, frontOn: facing('left', 'left') })).toEqual({ slots: { right: 1, left: 2 }, shapeOnly: [], flip: ['left'] });
    expect(autoAssign(sides, 'clip', none, { symmetric: true, frontOn: facing('right', 'right') })).toEqual({ slots: { left: 1, right: 2 }, shapeOnly: [], flip: ['right'] });
    // One side view: it serves its own side as it is and the other mirrored.
    expect(autoAssign([sides[0]], 'clip', none, { symmetric: true, frontOn: facing('right') })).toEqual({ slots: { left: 1, right: 1 }, shapeOnly: [], flip: ['right'] });
    // Orientation unknown (no cut-out): the right side, as photographed.
    expect(autoAssign([sides[0]], 'clip', none, { symmetric: true })).toEqual({ slots: { right: 1, left: 1 }, shapeOnly: [], flip: ['left'] });
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

describe('side views of a mirror-symmetric object', () => {
  const BG: RGB = [236, 234, 230];
  const RED: RGB = [140, 25, 20];
  const CREAM: RGB = [235, 215, 160];
  const DARK: RGB = [28, 24, 22];
  const YELLOW: RGB = [245, 205, 40];
  const ORANGE: RGB = [240, 120, 25];
  const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

  // A bottle on a 128x160 photo: a neck and a body 40 px wide, the same from the front and from the side.
  const bottleAt = (cx: number) => (x: number, y: number) => (y >= 10 && y < 30 ? Math.abs(x - cx) < 8 : y >= 30 && y < 150 && Math.abs(x - cx) < 20);
  // The front label has a dark band near its bottom; the back label a barcode in its middle.
  const label = (u: number, y: number, face: 'front' | 'back'): RGB => {
    if (face === 'front' && y >= 118 && y < 126) return DARK;
    if (face === 'back' && y >= 96 && y < 110 && Math.abs(u) < 0.4 && Math.floor(u * 40) % 2) return DARK;
    return CREAM;
  };
  const facePhoto = (face: 'front' | 'back') =>
    paint(128, 160, BG, (x, y) => {
      if (!bottleAt(64)(x, y)) return null;
      const u = (x - 64) / 20;
      return y >= 70 && y < 130 && Math.abs(u) < 0.9 ? label(u, y, face) : RED;
    });
  const front = facePhoto('front');
  const frontMask = maskOf(128, 160, bottleAt(64));
  const back = facePhoto('back');
  /**
   * The bottle from its right (+x): the front label's edge on the image's left, the back label's on its right, red
   * glass between them. Lit from the left. `mirror` gives the view from the left instead.
   */
  const sideView = (mirror = false) => {
    const img = paint(96, 160, BG, (px, y) => {
      const x = mirror ? 96 - px : px;
      if (!bottleAt(48)(x, y)) return null;
      const t = (x - 28) / 40;
      const light = 1 - 0.15 * t;
      if (y < 70 || y >= 130) return shade(RED, light);
      if (t < 0.3) return shade(label(0, y, 'front'), light);
      if (t > 0.7) return shade(label(t > 0.9 ? 0.1 : 0.5, y, 'back'), light);
      return shade(RED, light);
    });
    return { img, mask: maskOf(96, 160, bottleAt(48)) };
  };
  const edges = (v: { img: RGBAImage; mask: ReturnType<typeof maskOf> }) => edgeProfiles(v.img, v.mask)!;

  it('measures how mirror-symmetric an outline is', () => {
    expect(mirrorSymmetry(frontMask)).toBeGreaterThan(0.99);
    // A mug: its handle sticks out on one side only.
    const mug = maskOf(128, 128, (x, y) => (x >= 30 && x < 80 && y >= 30 && y < 100) || (x >= 80 && x < 100 && y >= 45 && y < 85 && !(x >= 84 && x < 96 && y >= 53 && y < 77)));
    expect(mirrorSymmetry(mug)).toBeLessThan(0.8);
    // A duck in profile: head at one end, tail at the other.
    const duck = maskOf(128, 128, (x, y) => ((x - 42) / 14) ** 2 + ((y - 44) / 14) ** 2 <= 1 || ((x - 66) / 46) ** 2 + ((y - 76) / 28) ** 2 <= 1);
    expect(mirrorSymmetry(duck)).toBeLessThan(MIN_MIRROR_IOU);
  });

  it('calls an object symmetric only if its outline is and its ends look alike', () => {
    expect(isMirrorSymmetric(frontMask, frontEndColors(front, frontMask)!)).toBe(true);
    // The same outline with an orange end and a yellow end.
    const bar = (x: number, y: number): RGB | null => (x >= 10 && x < 118 && y >= 40 && y < 88 ? (x < 40 ? ORANGE : YELLOW) : null);
    const barMask = maskOf(128, 128, (x, y) => bar(x, y) !== null);
    expect(mirrorSymmetry(barMask)).toBeGreaterThan(0.99);
    expect(isMirrorSymmetric(barMask, frontEndColors(paint(128, 128, BG, bar), barMask)!)).toBe(false);
    // One colour all over, but with a handle.
    const mug = (x: number, y: number) => (x >= 30 && x < 80 && y >= 30 && y < 100) || (x >= 80 && x < 96 && y >= 50 && y < 80);
    const mugMask = maskOf(128, 128, mug);
    const mugEnds = frontEndColors(paint(128, 128, BG, (x, y) => (mug(x, y) ? RED : null)), mugMask)!;
    expect(whichEnd(objectColors(paint(64, 64, BG, (x) => (Math.abs(x - 32) < 14 ? RED : null)), null), mugEnds).end).toBeNull();
    expect(isMirrorSymmetric(mugMask, mugEnds)).toBe(false);
  });

  it("tells which side of a side view the object's front is on", () => {
    const f = edges({ img: front, mask: frontMask });
    const b = edges({ img: back, mask: frontMask });
    const right = sideFacing(edges(sideView()), f, b);
    const left = sideFacing(edges(sideView(true)), f, b);
    expect(right.front).toBe('left');
    expect(left.front).toBe('right');
    expect(right.score).toBeGreaterThan(0.5);
    expect(left.score).toBeLessThan(-0.5);
    // Without a back view the front alone decides it.
    expect(sideFacing(edges(sideView()), f, null).front).toBe('left');
    expect(sideFacing(edges(sideView(true)), f, null).front).toBe('right');
  });

  it('works on cut-outs of the photos', () => {
    const cut = (img: RGBAImage) => {
      const seg = segmentByColor(img, { tolerance: 16, enclosedHoles: true, workSize: 256 });
      expect(seg.method).toBe('color-key');
      return seg.mask;
    };
    const f = edgeProfiles(front, cut(front))!;
    const b = edgeProfiles(back, cut(back))!;
    for (const mirror of [false, true]) {
      const { img } = sideView(mirror);
      expect(sideFacing(edgeProfiles(img, cut(img))!, f, b).front).toBe(mirror ? 'right' : 'left');
    }
  });

  it('textures both sides of the bottle instead of using its side view for shape only', () => {
    const ends = frontEndColors(front, frontMask)!;
    const side = sideView(true);
    // Its ends look alike, so the side view's end cannot be told...
    expect(whichEnd(objectColors(side.img, side.mask), ends).end).toBeNull();
    // ...but the bottle looks the same from either side.
    const symmetric = isMirrorSymmetric(frontMask, ends);
    const f = edges({ img: front, mask: frontMask });
    const b = edges({ img: back, mask: frontMask });
    const scored: Scored[] = [
      { index: 0, similarity: 0.95, probs: { front: 0.1, back: 0.7, side: 0.1, top: 0.1 }, view: 'back' },
      { index: 1, similarity: 0.94, probs: { front: 0.1, back: 0.1, side: 0.7, top: 0.1 }, view: 'side' },
    ];
    const picks = autoAssign(scored, 'color', () => null, {
      symmetric,
      frontOn: (i, backIndex) => (i === 1 ? sideFacing(edges(side), f, backIndex === 0 ? b : null).front : null),
    });
    // The view from the left fills the left slot as it is and, mirrored, the right one.
    expect(picks).toEqual({ slots: { back: 0, left: 1, right: 1 }, shapeOnly: [], flip: ['right'] });
  });
});
