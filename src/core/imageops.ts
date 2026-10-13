import type { ByteField, FloatField, RGBAImage } from './types';

export function createRGBA(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function createFloat(width: number, height: number, fill = 0): FloatField {
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function createByte(width: number, height: number): ByteField {
  return { width, height, data: new Uint8Array(width * height) };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of mask pixels >= threshold, or null when the mask is empty. */
export function maskBBox(mask: ByteField, threshold = 128): Rect | null {
  const { width, height, data } = mask;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (data[row + x] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Grow a rect by `pad` pixels on every side, clipped to the image. */
export function padRect(r: Rect, pad: number, width: number, height: number): Rect {
  const x0 = Math.max(0, r.x - pad);
  const y0 = Math.max(0, r.y - pad);
  const x1 = Math.min(width, r.x + r.width + pad);
  const y1 = Math.min(height, r.y + r.height + pad);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function cropRGBA(img: RGBAImage, r: Rect): RGBAImage {
  const out = createRGBA(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4;
    out.data.set(img.data.subarray(src, src + r.width * 4), y * r.width * 4);
  }
  return out;
}

export function cropByte(f: ByteField, r: Rect): ByteField {
  const out = createByte(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const src = (r.y + y) * f.width + r.x;
    out.data.set(f.data.subarray(src, src + r.width), y * r.width);
  }
  return out;
}

/**
 * Resample the part `r` of an image out of a float field that covers the
 * image rectangle `frame` (both in image pixels).
 */
export function cropFloatFrame(f: FloatField, r: Rect, frame: Rect): FloatField {
  const sx = f.width / frame.width;
  const sy = f.height / frame.height;
  const w = Math.max(1, Math.round(r.width * sx));
  const h = Math.max(1, Math.round(r.height * sy));
  const out = createFloat(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = (r.x - frame.x + ((x + 0.5) / w) * r.width) * sx - 0.5;
      const fy = (r.y - frame.y + ((y + 0.5) / h) * r.height) * sy - 0.5;
      out.data[y * w + x] = sampleFloat(f, fx, fy);
    }
  }
  return out;
}

/** Bilinear sample with clamp-to-edge; (x, y) in pixel-centre coordinates. */
export function sampleFloat(f: FloatField, x: number, y: number): number {
  const { width, height, data } = f;
  const xc = clamp(x, 0, width - 1);
  const yc = clamp(y, 0, height - 1);
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = xc - x0;
  const ty = yc - y0;
  const a = data[y0 * width + x0];
  const b = data[y0 * width + x1];
  const c = data[y1 * width + x0];
  const d = data[y1 * width + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Bilinear RGBA sample into `out` (length >= 4). */
export function sampleRGBA(img: RGBAImage, x: number, y: number, out: Float32Array | number[]): void {
  const { width, height, data } = img;
  const xc = clamp(x, 0, width - 1);
  const yc = clamp(y, 0, height - 1);
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = xc - x0;
  const ty = yc - y0;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c] * (1 - tx) + data[i10 + c] * tx;
    const bot = data[i01 + c] * (1 - tx) + data[i11 + c] * tx;
    out[c] = top * (1 - ty) + bot * ty;
  }
}

/** Area-averaging downscale / bilinear upscale of an RGBA image. */
export function resizeRGBA(img: RGBAImage, width: number, height: number): RGBAImage {
  if (width === img.width && height === img.height) {
    return { width, height, data: new Uint8ClampedArray(img.data) };
  }
  const out = createRGBA(width, height);
  const sx = img.width / width;
  const sy = img.height / height;
  if (sx <= 1 && sy <= 1) {
    const px = new Float32Array(4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        sampleRGBA(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, px);
        const o = (y * width + x) * 4;
        out.data[o] = px[0];
        out.data[o + 1] = px[1];
        out.data[o + 2] = px[2];
        out.data[o + 3] = px[3];
      }
    }
    return out;
  }
  const acc = new Float64Array(5);
  for (let y = 0; y < height; y++) {
    const fy0 = y * sy;
    const fy1 = Math.min(img.height, (y + 1) * sy);
    for (let x = 0; x < width; x++) {
      const fx0 = x * sx;
      const fx1 = Math.min(img.width, (x + 1) * sx);
      acc.fill(0);
      for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
        const wy = Math.min(yy + 1, fy1) - Math.max(yy, fy0);
        if (wy <= 0) continue;
        for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
          const wx = Math.min(xx + 1, fx1) - Math.max(xx, fx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (yy * img.width + xx) * 4;
          acc[0] += img.data[i] * w;
          acc[1] += img.data[i + 1] * w;
          acc[2] += img.data[i + 2] * w;
          acc[3] += img.data[i + 3] * w;
          acc[4] += w;
        }
      }
      const o = (y * width + x) * 4;
      const inv = acc[4] > 0 ? 1 / acc[4] : 0;
      out.data[o] = acc[0] * inv;
      out.data[o + 1] = acc[1] * inv;
      out.data[o + 2] = acc[2] * inv;
      out.data[o + 3] = acc[3] * inv;
    }
  }
  return out;
}

/** Resize a byte field (masks) with area averaging / bilinear upsampling. */
export function resizeByte(f: ByteField, width: number, height: number): ByteField {
  const asFloat: FloatField = { width: f.width, height: f.height, data: Float32Array.from(f.data) };
  const r = resizeFloat(asFloat, width, height);
  const out = createByte(width, height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.round(clamp(r.data[i], 0, 255));
  return out;
}

export function resizeFloat(f: FloatField, width: number, height: number): FloatField {
  const out = createFloat(width, height);
  const sx = f.width / width;
  const sy = f.height / height;
  if (sx <= 1 && sy <= 1) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        out.data[y * width + x] = sampleFloat(f, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
      }
    }
    return out;
  }
  for (let y = 0; y < height; y++) {
    const fy0 = y * sy;
    const fy1 = Math.min(f.height, (y + 1) * sy);
    for (let x = 0; x < width; x++) {
      const fx0 = x * sx;
      const fx1 = Math.min(f.width, (x + 1) * sx);
      let acc = 0;
      let wsum = 0;
      for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
        const wy = Math.min(yy + 1, fy1) - Math.max(yy, fy0);
        if (wy <= 0) continue;
        for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
          const wx = Math.min(xx + 1, fx1) - Math.max(xx, fx0);
          if (wx <= 0) continue;
          acc += f.data[yy * f.width + xx] * wx * wy;
          wsum += wx * wy;
        }
      }
      out.data[y * width + x] = wsum > 0 ? acc / wsum : 0;
    }
  }
  return out;
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian blur of a float buffer (clamp-to-edge). */
export function blurBuffer(data: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma <= 0.01) return new Float32Array(data);
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) >> 1;
  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= width ? width - 1 : x + i;
        acc += data[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= height ? height - 1 : y + i;
        acc += tmp[yy * width + x] * k[i + r];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

/**
 * Blur only inside the region where `weight` > 0 (normalised convolution), so
 * values never bleed across the silhouette.
 */
export function maskedBlur(values: Float32Array, weight: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma <= 0.01) return new Float32Array(values);
  const vw = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) vw[i] = values[i] * weight[i];
  const a = blurBuffer(vw, width, height, sigma);
  const b = blurBuffer(weight, width, height, sigma);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = weight[i] > 0 && b[i] > 1e-6 ? a[i] / b[i] : values[i];
  return out;
}

/**
 * Push-pull scattered-data interpolation (Gortler et al. 1996).
 * `values` has `channels` interleaved channels, `weights` in [0, 1] says how
 * much each pixel is known. Unknown pixels are filled smoothly from known ones.
 */
export function pushPull(values: Float32Array, weights: Float32Array, width: number, height: number, channels: number): Float32Array {
  interface Level { w: number; h: number; c: Float32Array; wt: Float32Array }
  const levels: Level[] = [];
  const c0 = new Float32Array(values);
  const w0 = new Float32Array(weights.length);
  for (let i = 0; i < weights.length; i++) w0[i] = clamp(weights[i], 0, 1);
  levels.push({ w: width, h: height, c: c0, wt: w0 });

  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const f = levels[levels.length - 1];
    const w = Math.max(1, Math.ceil(f.w / 2));
    const h = Math.max(1, Math.ceil(f.h / 2));
    const c = new Float32Array(w * h * channels);
    const wt = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let ws = 0;
        const acc = [0, 0, 0, 0];
        for (let dy = 0; dy < 2; dy++) {
          const fy = y * 2 + dy;
          if (fy >= f.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const fx = x * 2 + dx;
            if (fx >= f.w) continue;
            const fi = fy * f.w + fx;
            const fw = f.wt[fi];
            if (fw <= 0) continue;
            ws += fw;
            for (let ch = 0; ch < channels; ch++) acc[ch] += f.c[fi * channels + ch] * fw;
          }
        }
        const o = y * w + x;
        if (ws > 0) {
          for (let ch = 0; ch < channels; ch++) c[o * channels + ch] = acc[ch] / ws;
        }
        wt[o] = Math.min(1, ws);
      }
    }
    levels.push({ w, h, c, wt });
  }

  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l];
    const g = levels[l + 1];
    for (let y = 0; y < f.h; y++) {
      const gy = clamp((y + 0.5) / 2 - 0.5, 0, g.h - 1);
      const y0 = Math.floor(gy);
      const y1 = Math.min(y0 + 1, g.h - 1);
      const ty = gy - y0;
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const fw = f.wt[i];
        if (fw >= 1) continue;
        const gx = clamp((x + 0.5) / 2 - 0.5, 0, g.w - 1);
        const x0 = Math.floor(gx);
        const x1 = Math.min(x0 + 1, g.w - 1);
        const tx = gx - x0;
        for (let ch = 0; ch < channels; ch++) {
          const a = g.c[(y0 * g.w + x0) * channels + ch];
          const b = g.c[(y0 * g.w + x1) * channels + ch];
          const cc = g.c[(y1 * g.w + x0) * channels + ch];
          const d = g.c[(y1 * g.w + x1) * channels + ch];
          const up = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
          f.c[i * channels + ch] = f.c[i * channels + ch] * fw + up * (1 - fw);
        }
        f.wt[i] = 1;
      }
    }
  }
  return levels[0].c;
}

/**
 * Replace the colour of every pixel where `valid` is false with a smooth
 * extrapolation of nearby valid colours. Prevents background halos when the
 * texture is filtered at the silhouette.
 */
export function bleedRGBA(img: RGBAImage, valid: Uint8Array): RGBAImage {
  const n = img.width * img.height;
  const vals = new Float32Array(n * 3);
  const wts = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (valid[i]) {
      vals[i * 3] = img.data[i * 4];
      vals[i * 3 + 1] = img.data[i * 4 + 1];
      vals[i * 3 + 2] = img.data[i * 4 + 2];
      wts[i] = 1;
      any = true;
    }
  }
  const out = createRGBA(img.width, img.height);
  if (!any) {
    out.data.set(img.data);
    return out;
  }
  const filled = pushPull(vals, wts, img.width, img.height, 3);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (valid[i]) {
      out.data[o] = img.data[o];
      out.data[o + 1] = img.data[o + 1];
      out.data[o + 2] = img.data[o + 2];
    } else {
      out.data[o] = filled[i * 3];
      out.data[o + 1] = filled[i * 3 + 1];
      out.data[o + 2] = filled[i * 3 + 2];
    }
    out.data[o + 3] = 255;
  }
  return out;
}

export function luminance(img: RGBAImage): FloatField {
  const out = createFloat(img.width, img.height);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    out.data[i] = (0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2]) / 255;
  }
  return out;
}

/** Percentile of the values selected by `select` (or all values). */
export function percentile(data: ArrayLike<number>, p: number, select?: (i: number) => boolean): number {
  const vals: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (!select || select(i)) {
      const v = data[i];
      if (Number.isFinite(v)) vals.push(v);
    }
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  const idx = clamp((p / 100) * (vals.length - 1), 0, vals.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return vals[lo] + (vals[hi] - vals[lo]) * (idx - lo);
}

export function flipRGBA(img: RGBAImage): RGBAImage {
  const out = createRGBA(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = (y * img.width + (img.width - 1 - x)) * 4;
      out.data[d] = img.data[s];
      out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2];
      out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

export function flipByte(f: ByteField): ByteField {
  const out = createByte(f.width, f.height);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) out.data[y * f.width + (f.width - 1 - x)] = f.data[y * f.width + x];
  }
  return out;
}

export function flipFloat(f: FloatField): FloatField {
  const out = createFloat(f.width, f.height);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) out.data[y * f.width + (f.width - 1 - x)] = f.data[y * f.width + x];
  }
  return out;
}
