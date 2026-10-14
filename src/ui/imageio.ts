import type { ByteField, RGBAImage } from '../core/types';
import { proxied } from '../search/client';

/** Decode any browser-supported image blob into RGBA pixels, honouring EXIF orientation. */
export async function blobToRGBA(blob: Blob, maxSize: number): Promise<RGBAImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This file is not an image the browser can decode (try JPG, PNG or WebP).');
  }
  const s = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s));
  const h = Math.max(1, Math.round(bitmap.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const data = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: data.data };
}

/** Fetch an image file from the web through the same-origin proxy (same-origin and data: URLs directly). */
export async function fetchImage(url: string): Promise<Blob> {
  const res = await fetch(proxied(url));
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ? `Could not load image: ${body.error}` : `Could not load image (${res.status})`);
  }
  return res.blob();
}

/** Fetch an image from the web through the same-origin proxy and decode it. */
export async function urlToRGBA(url: string, maxSize: number): Promise<RGBAImage> {
  return blobToRGBA(await fetchImage(url), maxSize);
}

export function rgbaToCanvas(img: RGBAImage, canvas = document.createElement('canvas')): HTMLCanvasElement {
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas;
}

/** Draw a photo into a canvas; with a mask, the background is shown as a checkerboard. */
export function drawPreview(canvas: HTMLCanvasElement, img: RGBAImage, mask: ByteField | null, maxSide = 640): void {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const src = rgbaToCanvas(img);
  if (!mask) {
    ctx.drawImage(src, 0, 0, w, h);
    return;
  }
  const cell = 8;
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      ctx.fillStyle = ((x + y) / cell) % 2 === 0 ? '#2a2f3a' : '#3a4150';
      ctx.fillRect(x, y, cell, cell);
    }
  }
  const cut = new Uint8ClampedArray(img.data);
  for (let i = 0; i < mask.data.length; i++) cut[i * 4 + 3] = Math.min(cut[i * 4 + 3], mask.data[i]);
  const cutCanvas = rgbaToCanvas({ width: img.width, height: img.height, data: cut });
  ctx.drawImage(cutCanvas, 0, 0, w, h);
}

/** Pull an image reference out of a drop / paste: files, our own result tiles, URLs or HTML snippets. */
export type DroppedImage = { kind: 'file'; blob: Blob; name: string } | { kind: 'url'; url: string; name: string } | { kind: 'result'; index: number };

function unwrapSearchUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Google Images / Bing wrap the real image address in a parameter.
    for (const key of ['imgurl', 'mediaurl', 'img_url', 'url']) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v) && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(v)) return v;
    }
    for (const key of ['imgurl', 'mediaurl']) {
      const v = u.searchParams.get(key);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch {
    // keep raw
  }
  return raw;
}

export function readDataTransfer(dt: DataTransfer | null): DroppedImage | null {
  if (!dt) return null;
  const internal = dt.getData('application/x-trueform-result');
  if (internal) return { kind: 'result', index: Number(internal) };
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name)) return { kind: 'file', blob: f, name: f.name };
  }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return { kind: 'file', blob: f, name: f.name || 'pasted-image.png' };
    }
  }
  const html = dt.getData('text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const src = doc.querySelector('img')?.getAttribute('src');
    if (src && (/^https?:\/\//i.test(src) || src.startsWith('data:image/'))) {
      const link = doc.querySelector('a')?.getAttribute('href');
      const unwrapped = link ? unwrapSearchUrl(link) : src;
      const url = unwrapped !== link && /^https?:\/\//i.test(unwrapped) ? unwrapped : src;
      return { kind: 'url', url, name: nameFromUrl(url) };
    }
  }
  const uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
  if (uri && (/^https?:\/\//i.test(uri.trim()) || uri.startsWith('data:image/'))) {
    const url = unwrapSearchUrl(uri.trim());
    return { kind: 'url', url, name: nameFromUrl(url) };
  }
  return null;
}

export function nameFromUrl(url: string): string {
  if (url.startsWith('data:')) return 'web-image';
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'web-image';
  } catch {
    return 'web-image';
  }
}
