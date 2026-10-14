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

type RGB = [number, number, number];

/** The test vase: a round vase with a coloured band, a printed "logo" on its front and pin stripes on its back. */
function vaseShape(width: number, height: number) {
  const cx = width / 2;
  const top = height * 0.12;
  const bottom = height * 0.9;
  const radius = (t: number) => width * (0.12 + 0.2 * Math.sin(Math.PI * (0.15 + 0.8 * t)) + 0.05 * Math.cos(t * 9));
  /** Where pixel (x, y) of a photo from the front or the back hits the vase: its colour, and how far off centre it is in radii (dx). */
  const at = (x: number, y: number, side: 'front' | 'back'): { color: RGB; dx: number } | null => {
    if (y < top || y > bottom) return null;
    const t = (y - top) / (bottom - top);
    const R = radius(t);
    const dx = (x - cx) / R;
    if (Math.abs(dx) > 1) return null;
    let color: RGB = [200, 70, 40];
    if (t > 0.42 && t < 0.58) color = [240, 200, 60];
    // The front carries a checkered "logo"; the back has vertical pin stripes instead.
    if (side === 'front' && Math.abs(x - cx) < R * 0.28 && t > 0.2 && t < 0.36) color = (Math.floor((x - cx) / 8) + Math.floor(y / 8)) % 2 ? [20, 20, 30] : [250, 250, 250];
    if (side === 'back' && t > 0.6 && Math.floor((x - cx + 1000) / 10) % 3 === 0) color = [60, 30, 120];
    return { color, dx };
  };
  return { cx, radius: (y: number) => radius((y - top) / (bottom - top)), at };
}

function shadedPhoto(width: number, height: number, surface: (x: number, y: number) => { color: RGB; dx: number } | null): Buffer {
  const px = new Uint8Array(width * height * 4);
  const cx = width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      // Backdrop with a gentle vignette.
      const v = 238 - Math.hypot(x - cx, y - height / 2) * 0.03;
      let r = v, g = v, b = v + 2;
      const s = surface(x, y);
      if (s) {
        const shade = 0.35 + 0.65 * Math.sqrt(1 - s.dx * s.dx) * (0.8 + 0.2 * (1 - s.dx));
        r = s.color[0] * shade;
        g = s.color[1] * shade;
        b = s.color[2] * shade;
      }
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }
  return encodePNG(width, height, px);
}

/**
 * A shaded vase with a coloured band and a printed "logo" on a light studio
 * backdrop: enough structure to see texture fidelity in screenshots.
 */
export function vasePhoto(width = 640, height = 640, side: 'front' | 'back' = 'front'): Buffer {
  const vase = vaseShape(width, height);
  return shadedPhoto(width, height, (x, y) => vase.at(x, y, side));
}

/**
 * The vase from its right (+x) or left side. It is round, so its outline is the
 * same as from the front; one edge shows the middle of its front (the logo), the
 * other the middle of its back (the stripes): seen from the right, the front is
 * on the image's left.
 */
export function vaseSidePhoto(width = 400, height = 400, from: 'right' | 'left' = 'right'): Buffer {
  const vase = vaseShape(width, height);
  return shadedPhoto(width, height, (x, y) => {
    const hit = vase.at(x, y, 'front');
    if (!hit) return null;
    // Angle of the surface point from the front, and how far towards the side it is as the front or back camera sees it.
    const theta = Math.acos(Math.max(-1, Math.min(1, from === 'right' ? -hit.dx : hit.dx)));
    const off = Math.sin(theta) * vase.radius(y) * (from === 'right' ? 1 : -1);
    const face = theta <= Math.PI / 2 ? 'front' : 'back';
    // The back camera sees the vase's right on its left.
    const src = vase.at(vase.cx + (face === 'front' ? off : -off), y, face);
    return { color: src?.color ?? hit.color, dx: hit.dx };
  });
}


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

const MUG_RED: RGB = [180, 40, 35];
const scaled = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/**
 * A mug of one colour with its handle on the right: both ends look alike, but
 * the outline is not mirror-symmetric, so which end a side view shows matters.
 * 'side' is a closer view from its right (+x), the handle pointing at the camera.
 */
export function mugPhoto(view: 'profile' | 'side', size = 320): Buffer {
  const [x0, x1, y0, y1] = view === 'profile' ? [0.28, 0.66, 0.25, 0.8] : [0.2, 0.8, 0.14, 0.88];
  const cx = (x0 + x1) / 2;
  return drawing(size, size, (x, y) => {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      if (view === 'side' && Math.abs(x - cx) < 0.04 && y > 0.3 && y < 0.72) return scaled(MUG_RED, 0.75);
      const dx = (x - cx) / ((x1 - x0) / 2);
      return scaled(MUG_RED, 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - dx * dx)));
    }
    if (view === 'profile' && x > x1 && inEllipse(x, y, 0.7, 0.52, 0.11, 0.16) && !inEllipse(x, y, 0.7, 0.52, 0.06, 0.1)) return scaled(MUG_RED, 0.8);
    return null;
  });
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
        // The vase's outline is mirror-symmetric and its ends look alike: this view from its right serves both sides.
        { id: 'test-vase-side', title: 'Test vase, side', file: 'samples/test-vase/side.png', hint: 'side', source: 'Sample render' },
      ],
    },
    {
      id: 'test-mug',
      title: 'Test mug',
      query: 'red test mug',
      photo: 'samples/test-mug/profile.png',
      references: [
        // Its ends look alike but the handle makes it asymmetric: which end this shows is unknown, so it only sets the depth.
        { id: 'test-mug-side', title: 'Test mug, side', file: 'samples/test-mug/side.png', hint: 'side', source: 'Sample render' },
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
    'test-vase/side.png': vaseSidePhoto(400, 400, 'right'),
    'test-mug/profile.png': mugPhoto('profile', 480),
    'test-mug/side.png': mugPhoto('side'),
    'test-toy/profile.png': toyPhoto('profile', 480),
    'test-toy/nose.png': toyPhoto('nose'),
    'test-toy/tail.png': toyPhoto('tail'),
  };
  await page.route('**/samples/manifest.json', (route) => route.fulfill({ json: SAMPLE_MANIFEST }));
  await page.route(/\/samples\/test-(vase|toy|mug)\/[^/]+$/, (route) => {
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
