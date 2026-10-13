import { createByte, resizeByte } from '../core/imageops';
import type { ByteField, FloatField, RGBAImage } from '../core/types';
import type { ImagePayload, MLProgress, MLRequest, MLResult, WorkerIn, WorkerOut } from './protocol';

type ProgressFn = (p: MLProgress) => void;

interface Pending {
  resolve: (r: MLResult) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressFn;
}

function payload(img: RGBAImage): ImagePayload {
  // Copy: the worker owns transferred buffers and callers keep using their image.
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Promise-based wrapper around the transformers.js worker. Created lazily so nothing downloads until AI is used. */
export class MLClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.kind === 'progress') {
        p.onProgress?.(msg.progress);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.kind === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    w.onerror = (e) => {
      const err = new Error(e.message || 'AI worker crashed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  private request(request: MLRequest, onProgress?: ProgressFn): Promise<MLResult> {
    const id = ++this.seq;
    const w = this.ensure();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const transfer: Transferable[] = [];
      if (request.type === 'segment' || request.type === 'depth') transfer.push(request.image.data.buffer);
      if (request.type === 'embedImages') for (const im of request.images) transfer.push(im.data.buffer);
      const msg: WorkerIn = { id, request };
      w.postMessage(msg, transfer);
    });
  }

  async device(): Promise<{ device: string; crossOriginIsolated: boolean }> {
    const r = await this.request({ type: 'device' });
    if (r.type !== 'device') throw new Error('Unexpected reply');
    return r;
  }

  /** AI matte of the object, resized to the image's size. */
  async segment(img: RGBAImage, model: string, onProgress?: ProgressFn): Promise<ByteField> {
    const r = await this.request({ type: 'segment', image: payload(img), model }, onProgress);
    if (r.type !== 'segment') throw new Error('Unexpected reply');
    const mask = createByte(r.width, r.height);
    mask.data.set(r.alpha);
    return r.width === img.width && r.height === img.height ? mask : resizeByte(mask, img.width, img.height);
  }

  /** Relative inverse depth (larger = closer) covering the same frame as `img`. */
  async depth(img: RGBAImage, model: string, onProgress?: ProgressFn): Promise<FloatField> {
    const r = await this.request({ type: 'depth', image: payload(img), model }, onProgress);
    if (r.type !== 'depth') throw new Error('Unexpected reply');
    return { width: r.width, height: r.height, data: r.data };
  }

  async embedImages(images: RGBAImage[], model: string, onProgress?: ProgressFn): Promise<Float32Array[]> {
    const r = await this.request({ type: 'embedImages', images: images.map(payload), model }, onProgress);
    if (r.type !== 'embeddings') throw new Error('Unexpected reply');
    return r.vectors;
  }

  async embedTexts(texts: string[], model: string, onProgress?: ProgressFn): Promise<Float32Array[]> {
    const r = await this.request({ type: 'embedTexts', texts, model }, onProgress);
    if (r.type !== 'embeddings') throw new Error('Unexpected reply');
    return r.vectors;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
