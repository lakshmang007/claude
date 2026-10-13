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
