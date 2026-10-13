/// <reference lib="webworker" />
import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  env,
  pipeline,
  RawImage,
} from '@huggingface/transformers';
import type { ImagePayload, MLProgress, MLRequest, MLResult, WorkerIn, WorkerOut } from './protocol';

env.allowLocalModels = false;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

type Device = 'webgpu' | 'wasm';

let deviceInfo: Promise<{ device: Device; fp16: boolean }> | null = null;
function detectDevice(): Promise<{ device: Device; fp16: boolean }> {
  deviceInfo ??= (async () => {
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
      const adapter = gpu ? await gpu.requestAdapter() : null;
      if (adapter) return { device: 'webgpu' as Device, fp16: adapter.features.has('shader-f16') };
    } catch {
      // fall through to WASM
    }
    return { device: 'wasm' as Device, fp16: false };
  })();
  return deviceInfo;
}

function post(msg: WorkerOut, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

function progressFor(id: number, model: string) {
  return (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => {
    const progress: MLProgress = { model, status: p.status, file: p.file, loaded: p.loaded, total: p.total };
    post({ kind: 'progress', id, progress });
  };
}

const cache = new Map<string, Promise<unknown>>();

/**
 * Load something once. On WebGPU failures (missing ops, no fp16 support,
 * driver issues) retry on WASM so the user still gets a result.
 */
function once<T>(key: string, factory: (device: Device, fp16: boolean) => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = (async () => {
      const { device, fp16 } = await detectDevice();
      if (device === 'webgpu') {
        try {
          return await factory('webgpu', fp16);
        } catch (e) {
          console.warn(`[ml] ${key} failed on WebGPU, retrying on WASM`, e);
        }
      }
      return factory('wasm', false);
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

function toRaw(img: ImagePayload): RawImage {
  return new RawImage(img.data, img.width, img.height, 4);
}

type AnyPipe = (input: unknown, ...rest: unknown[]) => Promise<unknown>;

/** RMBG-1.4 ships as a custom architecture; this is the loading recipe from its model card. */
async function loadRmbg(model: string, device: Device, fp16: boolean, id: number) {
  const net = await AutoModel.from_pretrained(model, {
    config: { model_type: 'custom' } as never,
    device,
    dtype: device === 'webgpu' ? (fp16 ? 'fp16' : 'fp32') : 'q8',
    progress_callback: progressFor(id, model),
  });
  const processor = await AutoProcessor.from_pretrained(model, {
    config: {
      do_normalize: true,
      do_pad: false,
      do_rescale: true,
      do_resize: true,
      image_mean: [0.5, 0.5, 0.5],
      feature_extractor_type: 'ImageFeatureExtractor',
      image_std: [1, 1, 1],
      resample: 2,
      rescale_factor: 0.00392156862745098,
      size: { width: 1024, height: 1024 },
    } as never,
  });
  return async (image: RawImage) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { pixel_values } = await (processor as any)(image);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { output } = await (net as any)({ input: pixel_values });
    const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(image.width, image.height);
    return mask.data as Uint8Array;
  };
}

async function segment(id: number, image: ImagePayload, model: string): Promise<MLResult> {
  const raw = toRaw(image);
  if (/rmbg-1\.4/i.test(model)) {
    const run = await once(`seg:${model}`, (d, f) => loadRmbg(model, d, f, id));
    const alpha = await run(raw);
    return { type: 'segment', width: image.width, height: image.height, alpha: new Uint8Array(alpha), model };
  }
  const pipe = (await once(`seg:${model}`, (device, fp16) =>
    pipeline('background-removal', model, { device, dtype: device === 'webgpu' && fp16 ? 'fp16' : 'fp32', progress_callback: progressFor(id, model) }),
  )) as unknown as AnyPipe;
  const out = (await pipe(raw)) as RawImage | RawImage[];
  const res = Array.isArray(out) ? out[0] : out;
  const rgba = res.channels === 4 ? res : res.rgba();
  const alpha = new Uint8Array(rgba.width * rgba.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba.data[i * 4 + 3];
  return { type: 'segment', width: rgba.width, height: rgba.height, alpha, model };
}

async function depth(id: number, image: ImagePayload, model: string): Promise<MLResult> {
  const pipe = (await once(`depth:${model}`, (device, fp16) =>
    pipeline('depth-estimation', model, { device, dtype: device === 'webgpu' && fp16 ? 'fp16' : 'fp32', progress_callback: progressFor(id, model) }),
  )) as unknown as AnyPipe;
  const out = (await pipe(toRaw(image))) as { predicted_depth: { dims: number[]; data: Float32Array } };
  const dims = out.predicted_depth.dims;
  const h = dims[dims.length - 2];
  const w = dims[dims.length - 1];
  return { type: 'depth', width: w, height: h, data: new Float32Array(out.predicted_depth.data), model };
}

interface Clip {
  processor: (images: RawImage[]) => Promise<{ pixel_values: unknown }>;
  tokenizer: (texts: string[], o: { padding: boolean; truncation: boolean }) => unknown;
  vision: (inputs: unknown) => Promise<{ image_embeds: { data: Float32Array; dims: number[] } }>;
  text: (inputs: unknown) => Promise<{ text_embeds: { data: Float32Array; dims: number[] } }>;
}

function loadClip(id: number, model: string): Promise<Clip> {
  // CLIP only ranks thumbnails; the quantised WASM build is small and fast enough.
  return once(`clip:${model}`, async () => {
    const opts = { device: 'wasm' as const, dtype: 'q8' as const, progress_callback: progressFor(id, model) };
    const [processor, tokenizer, vision, text] = await Promise.all([
      AutoProcessor.from_pretrained(model),
      AutoTokenizer.from_pretrained(model),
      CLIPVisionModelWithProjection.from_pretrained(model, opts),
      CLIPTextModelWithProjection.from_pretrained(model, opts),
    ]);
    return { processor, tokenizer, vision, text } as unknown as Clip;
  });
}

function splitNormalized(data: Float32Array, dims: number[]): Float32Array[] {
  const [n, d] = [dims[0], dims[dims.length - 1]];
  const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(data.subarray(i * d, (i + 1) * d));
    let len = 0;
    for (let k = 0; k < d; k++) len += v[k] * v[k];
    len = Math.sqrt(len) || 1;
    for (let k = 0; k < d; k++) v[k] /= len;
    out.push(v);
  }
  return out;
}

async function embedImages(id: number, images: ImagePayload[], model: string): Promise<MLResult> {
  const clip = await loadClip(id, model);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < images.length; i += 8) {
    const batch = images.slice(i, i + 8).map(toRaw);
    const inputs = await clip.processor(batch);
    const { image_embeds } = await clip.vision(inputs);
    vectors.push(...splitNormalized(image_embeds.data, image_embeds.dims));
  }
  return { type: 'embeddings', dim: vectors[0]?.length ?? 0, vectors };
}

async function embedTexts(id: number, texts: string[], model: string): Promise<MLResult> {
  const clip = await loadClip(id, model);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const inputs = clip.tokenizer(texts.slice(i, i + 64), { padding: true, truncation: true });
    const { text_embeds } = await clip.text(inputs);
    vectors.push(...splitNormalized(text_embeds.data, text_embeds.dims));
  }
  return { type: 'embeddings', dim: vectors[0]?.length ?? 0, vectors };
}

async function handle(id: number, req: MLRequest): Promise<MLResult> {
  switch (req.type) {
    case 'device': {
      const { device } = await detectDevice();
      return { type: 'device', device, crossOriginIsolated: ctx.crossOriginIsolated };
    }
    case 'segment':
      return segment(id, req.image, req.model);
    case 'depth':
      return depth(id, req.image, req.model);
    case 'embedImages':
      return embedImages(id, req.images, req.model);
    case 'embedTexts':
      return embedTexts(id, req.texts, req.model);
  }
}

ctx.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const { id, request } = e.data;
  try {
    const result = await handle(id, request);
    const transfer: Transferable[] = [];
    if (result.type === 'segment') transfer.push(result.alpha.buffer);
    if (result.type === 'depth') transfer.push(result.data.buffer);
    post({ kind: 'result', id, result }, transfer);
  } catch (err) {
    post({ kind: 'error', id, error: err instanceof Error ? err.message : String(err) });
  }
};
