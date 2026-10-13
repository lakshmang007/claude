/// <reference lib="webworker" />
import { reconstruct } from './reconstruct';
import type { MeshResult, ReconstructInput } from './types';

export type ReconstructWorkerIn = { id: number; input: ReconstructInput };
export type ReconstructWorkerOut =
  | { id: number; kind: 'progress'; stage: string; fraction: number }
  | { id: number; kind: 'result'; result: MeshResult }
  | { id: number; kind: 'error'; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<ReconstructWorkerIn>) => {
  const { id, input } = e.data;
  try {
    const result = reconstruct(input, (stage, fraction) => ctx.postMessage({ id, kind: 'progress', stage, fraction } satisfies ReconstructWorkerOut));
    const transfer = [result.positions.buffer, result.normals.buffer, result.uvs.buffer, result.indices.buffer, result.atlas.data.buffer, result.frontPhoto.data.buffer];
    ctx.postMessage({ id, kind: 'result', result } satisfies ReconstructWorkerOut, transfer);
  } catch (err) {
    ctx.postMessage({ id, kind: 'error', error: err instanceof Error ? err.message : String(err) } satisfies ReconstructWorkerOut);
  }
};
