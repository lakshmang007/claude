import { expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA pixels as a PNG. */
export function encodePNG(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A shaded vase with a coloured band and a printed "logo" on a light studio
 * backdrop: enough structure to see texture fidelity in screenshots.
 */
export function vasePhoto(width = 640, height = 640, side: 'front' | 'back' = 'front'): Buffer {
  const px = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const top = height * 0.12;
  const bottom = height * 0.9;
  const radius = (t: number) => width * (0.12 + 0.2 * Math.sin(Math.PI * (0.15 + 0.8 * t)) + 0.05 * Math.cos(t * 9));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      // Backdrop with a gentle vignette.
      const v = 238 - Math.hypot(x - cx, y - height / 2) * 0.03;
      let r = v, g = v, b = v + 2;
      if (y >= top && y <= bottom) {
        const t = (y - top) / (bottom - top);
        const R = radius(t);
        const dx = (x - cx) / R;
        if (Math.abs(dx) <= 1) {
          const shade = 0.35 + 0.65 * Math.sqrt(1 - dx * dx) * (0.8 + 0.2 * (1 - dx));
          let base = [200, 70, 40];
          if (t > 0.42 && t < 0.58) base = [240, 200, 60];
          // The front carries a checkered "logo"; the back has vertical pin stripes instead.
          if (side === 'front' && Math.abs(x - cx) < R * 0.28 && t > 0.2 && t < 0.36) base = (Math.floor((x - cx) / 8) + Math.floor(y / 8)) % 2 ? [20, 20, 30] : [250, 250, 250];
          if (side === 'back' && t > 0.6 && Math.floor((x - cx + 1000) / 10) % 3 === 0) base = [60, 30, 120];
          r = base[0] * shade;
          g = base[1] * shade;
          b = base[2] * shade;
        }
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  return encodePNG(width, height, px);
}

type RGB = [number, number, number];

/** A flat-shaded drawing on a light backdrop: `shape` gives the colour of object pixels, null for backdrop. */
function drawing(width: number, height: number, shape: (x: number, y: number) => RGB | null): Buffer {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = shape(x / width, y / height) ?? [236, 234, 230];
      px.set([...c, 255], (y * width + x) * 4);
    }
  }
  return encodePNG(width, height, px);
}

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const YELLOW: RGB = [245, 205, 40];
const ORANGE: RGB = [240, 120, 25];
const BLUE: RGB = [40, 80, 210];

/**
 * A toy that differs end to end: an orange nose at its left (-x) end and a blue
 * tail at its right. 'nose' is the view of the left end from a camera at -x,
 * 'tail' the right end from +x.
 */
export function toyPhoto(view: 'profile' | 'nose' | 'tail', size = 320): Buffer {
  if (view === 'profile') {
    return drawing(size, size, (x, y) => {
      if (inEllipse(x, y, 0.18, 0.5, 0.08, 0.06)) return ORANGE;
      if (inEllipse(x, y, 0.82, 0.48, 0.08, 0.1)) return BLUE;
      return inEllipse(x, y, 0.5, 0.52, 0.36, 0.2) ? YELLOW : null;
    });
  }
  const end = view === 'nose' ? ORANGE : BLUE;
  return drawing(size, size, (x, y) => (inEllipse(x, y, 0.5, 0.5, 0.1, 0.08) ? end : inEllipse(x, y, 0.5, 0.52, 0.3, 0.22) ? YELLOW : null));
}

export const SAMPLE_MANIFEST = {
  samples: [
    {
      id: 'test-vase',
      title: 'Test vase',
      query: 'ceramic test vase',
      photo: 'samples/test-vase/front.png',
      references: [
        { id: 'test-vase-front', title: 'Test vase, front', file: 'samples/test-vase/front-small.png', hint: 'any', source: 'Sample render' },
        { id: 'test-vase-back', title: 'Test vase, back', file: 'samples/test-vase/back.png', hint: 'back', source: 'Sample render' },
        // A symmetric vase looks the same from either side: usable for its depth, not its texture.
        { id: 'test-vase-side', title: 'Test vase, side', file: 'samples/test-vase/side.png', hint: 'side', source: 'Sample render' },
      ],
    },
    {
      id: 'test-toy',
      title: 'Test toy',
      query: 'yellow test toy',
      photo: 'samples/test-toy/profile.png',
      references: [
        { id: 'test-toy-tail', title: 'Test toy, tail end', file: 'samples/test-toy/tail.png', hint: 'side', source: 'Sample render' },
        { id: 'test-toy-nose', title: 'Test toy, nose end', file: 'samples/test-toy/nose.png', hint: 'side', source: 'Sample render' },
      ],
    },
  ],
};

/** Serve a sample manifest and its images from route mocks, so tests do not depend on public/samples. */
export async function mockSamples(page: Page): Promise<void> {
  const files: Record<string, Buffer> = {
    'test-vase/front.png': vasePhoto(),
    'test-vase/front-small.png': vasePhoto(300, 300, 'front'),
    'test-vase/back.png': vasePhoto(400, 400, 'back'),
    'test-vase/side.png': vasePhoto(400, 400, 'front'),
    'test-toy/profile.png': toyPhoto('profile', 480),
    'test-toy/nose.png': toyPhoto('nose'),
    'test-toy/tail.png': toyPhoto('tail'),
  };
  await page.route('**/samples/manifest.json', (route) => route.fulfill({ json: SAMPLE_MANIFEST }));
  await page.route(/\/samples\/test-(vase|toy)\/[^/]+$/, (route) => {
    const body = files[new URL(route.request().url()).pathname.split('/').slice(-2).join('/')];
    return body ? route.fulfill({ body, contentType: 'image/png' }) : route.fulfill({ status: 404 });
  });
}

/** Every toolbar button can be clicked: nothing (the stats, the export bar) lies on top of its centre. */
export async function expectToolbarClickable(page: Page): Promise<void> {
  const blocked = await page.$$eval('#toolbar button', (buttons) =>
    buttons
      .map((b) => {
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top && (top === b || b.contains(top)) ? null : `${b.textContent} is under ${top?.id || top?.className || top?.tagName}`;
      })
      .filter((v) => v),
  );
  expect(blocked).toEqual([]);
}
