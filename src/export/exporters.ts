import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { USDZExporter } from 'three/examples/jsm/exporters/USDZExporter.js';
import { createZip } from './zip';

export interface ExportMesh {
  positions: Float32Array;
  normals?: Float32Array;
  /** glTF convention (v down). */
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Wavefront OBJ text with UVs (OBJ uses v up) referencing `materialFile`. */
export function writeOBJ(m: ExportMesh, scale: number, materialFile = 'model.mtl', material = 'photo'): string {
  const lines: string[] = ['# TrueForm 3D export', `mtllib ${materialFile}`, 'o model'];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${(p[i] * scale).toFixed(6)} ${(p[i + 1] * scale).toFixed(6)} ${(p[i + 2] * scale).toFixed(6)}`);
  for (let i = 0; i < m.uvs.length; i += 2) lines.push(`vt ${m.uvs[i].toFixed(6)} ${(1 - m.uvs[i + 1]).toFixed(6)}`);
  const n = m.normals;
  if (n) for (let i = 0; i < n.length; i += 3) lines.push(`vn ${n[i].toFixed(5)} ${n[i + 1].toFixed(5)} ${n[i + 2].toFixed(5)}`);
  lines.push(`usemtl ${material}`, 's 1');
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] + 1, b = m.indices[t + 1] + 1, c = m.indices[t + 2] + 1;
    lines.push(n ? `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}` : `f ${a}/${a} ${b}/${b} ${c}/${c}`);
  }
  return lines.join('\n') + '\n';
}

export function writeMTL(textureFile: string, material = 'photo'): string {
  return [`newmtl ${material}`, 'Ka 1 1 1', 'Kd 1 1 1', 'Ks 0 0 0', 'd 1', 'illum 1', `map_Kd ${textureFile}`, ''].join('\n');
}

/** Binary STL (triangle soup with facet normals). */
export function writeSTL(m: ExportMesh, scale: number): ArrayBuffer {
  const triCount = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const header = 'TrueForm 3D binary STL';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triCount, true);
  const p = m.positions;
  let o = 84;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, p[v] * scale, true);
      view.setFloat32(o + 4, p[v + 1] * scale, true);
      view.setFloat32(o + 8, p[v + 2] * scale, true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

function scaledGeometry(m: ExportMesh, scale: number, flipV: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(m.positions.length);
  for (let i = 0; i < pos.length; i++) pos[i] = m.positions[i] * scale;
  const uv = new Float32Array(m.uvs);
  if (flipV) for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i];
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  if (m.normals) g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.normals), 3));
  else g.computeVertexNormals();
  return g;
}

function atlasTexture(atlas: HTMLCanvasElement, flipY: boolean): THREE.Texture {
  const tex = new THREE.CanvasTexture(atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = flipY;
  tex.userData.mimeType = 'image/jpeg';
  return tex;
}

function material(tex: THREE.Texture, unlit: boolean): THREE.Material {
  return unlit ? new THREE.MeshBasicMaterial({ map: tex }) : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
}

/** Binary glTF with the atlas embedded as JPEG. `scale` converts model units to metres. */
export async function exportGLB(m: ExportMesh, atlas: HTMLCanvasElement, scale: number, unlit: boolean): Promise<Blob> {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(scaledGeometry(m, scale, false), material(atlasTexture(atlas, false), unlit));
  mesh.name = 'TrueFormModel';
  scene.add(mesh);
  const result = await new GLTFExporter().parseAsync(scene, { binary: true });
  return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
}

/** USDZ for AR Quick Look (iOS/macOS). USD expects v-up UVs, like three's default texture convention. */
export async function exportUSDZ(m: ExportMesh, atlas: HTMLCanvasElement, scale: number): Promise<Blob> {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(scaledGeometry(m, scale, true), material(atlasTexture(atlas, true), false));
  mesh.name = 'TrueFormModel';
  scene.add(mesh);
  const data = await new USDZExporter().parseAsync(scene, { maxTextureSize: 2048, quickLookCompatible: true });
  return new Blob([data], { type: 'model/vnd.usdz+zip' });
}

async function canvasBytes(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
  if (!blob) throw new Error('Could not encode the texture');
  return new Uint8Array(await blob.arrayBuffer());
}

/** OBJ + MTL + texture in one zip. */
export async function exportOBJZip(m: ExportMesh, atlas: HTMLCanvasElement, scale: number): Promise<Blob> {
  const enc = new TextEncoder();
  const zip = createZip([
    { name: 'model.obj', data: enc.encode(writeOBJ(m, scale)) },
    { name: 'model.mtl', data: enc.encode(writeMTL('texture.jpg')) },
    { name: 'texture.jpg', data: await canvasBytes(atlas, 'image/jpeg', 0.95) },
  ]);
  return new Blob([zip as BlobPart], { type: 'application/zip' });
}

export function exportSTL(m: ExportMesh, scale: number): Blob {
  return new Blob([writeSTL(m, scale)], { type: 'model/stl' });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
