import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeOBJ, writeSTL } from '../../src/export/exporters';
import { createZip, crc32 } from '../../src/export/zip';
import { queryFromFilename, topLabels } from '../../src/search/identify';
import { autoAssign, colorSignature, histogramSimilarity, hintOnlyProbs, type Scored } from '../../src/search/rank';
import { paint } from './helpers';

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
    expect(picks).toEqual({ back: 1, right: 2 });
  });

  it('assigns nothing when no result is similar enough', () => {
    expect(autoAssign([mk(0, 0.4, { back: 0.9 })], 'clip')).toEqual({});
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
