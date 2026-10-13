/** Messages exchanged between the UI thread and the ML worker. */

export interface ImagePayload {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type MLRequest =
  | { type: 'device' }
  | { type: 'segment'; image: ImagePayload; model: string }
  | { type: 'depth'; image: ImagePayload; model: string }
  | { type: 'embedImages'; images: ImagePayload[]; model: string }
  | { type: 'embedTexts'; texts: string[]; model: string };

export type MLResult =
  | { type: 'device'; device: 'webgpu' | 'wasm'; crossOriginIsolated: boolean }
  | { type: 'segment'; width: number; height: number; alpha: Uint8Array; model: string }
  | { type: 'depth'; width: number; height: number; data: Float32Array; model: string }
  | { type: 'embeddings'; dim: number; vectors: Float32Array[] };

export interface MLProgress {
  model: string;
  file?: string;
  status: string;
  loaded?: number;
  total?: number;
}

export type WorkerOut =
  | { kind: 'result'; id: number; result: MLResult }
  | { kind: 'error'; id: number; error: string }
  | { kind: 'progress'; id: number; progress: MLProgress };

export type WorkerIn = { id: number; request: MLRequest };

export const DEFAULT_MODELS = {
  depth: 'onnx-community/depth-anything-v2-small',
  segment: 'briaai/RMBG-1.4',
  clip: 'Xenova/clip-vit-base-patch32',
};
