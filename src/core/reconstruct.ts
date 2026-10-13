import { colSpans, rowSpans, type Spans } from './align';
import { matchColors } from './color';
import {
  cropByte,
  cropFloatFrame,
  cropRGBA,
  flipByte,
  flipFloat,
  flipRGBA,
  luminance,
  maskBBox,
  padRect,
  resizeByte,
  resizeFloat,
  resizeRGBA,
  blurBuffer,
} from './imageops';
import { distanceTransform } from './distance';
import { buildTwoLayerMesh, isWatertight } from './mesh';
import {
  analyseSilhouette,
  applyExtentConstraints,
  backFromReference,
  capWeights,
  depthRelief,
  detectCaps,
  extentFromReference,
  frontShape,
  layerNormals,
  mirrorCaps,
  profileRatio,
  rimOffsets,
  ringOffsets,
  type Cap,
  type ExtentConstraint,
  type Relief,
} from './shape';
import { atlasLayout, bakeAtlas, bleedReference, type TextureRef } from './texture';
import type { ByteField, FloatField, MeshResult, ReconstructInput, RGBAImage, ViewInput, ViewName } from './types';

/** Longest side reference photos are reduced to before use. */
const REF_MAX = 1024;

interface PreparedRef {
  name: ViewName;
  image: RGBAImage;
  mask: ByteField;
  depth?: FloatField;
  rows: Spans;
  cols: Spans;
  geometryOnly: boolean;
}

/**
 * Distance from every grid pixel centre to the object outline, measured on the
 * full-resolution cut-out and expressed in grid pixels. With caps, their
 * outline does not count (the distance near a flat end is to the walls).
 */
function fineDistance(mask: ByteField, W: number, H: number, caps: Cap[] = []): Float32Array {
  // Signed distance (positive inside) at full resolution is linear across the
  // outline, so area-averaging it per grid cell and blurring it stay unbiased
  // while removing the pixel staircase of the cut-out.
  const n = mask.width * mask.height;
  let on = binarize(mask);
  let rows = mask.height;
  let top = 0;
  if (caps.length) {
    const sx = mask.width / W;
    const sy = mask.height / H;
    const spans = caps.map((c) => ({ side: c.side, c0: Math.round(c.x0 * sx), c1: Math.round((c.x1 + 1) * sx) }));
    // Deep enough that the walls, not the end of the mirror, are the nearest outline at a cap.
    const half = Math.max(...caps.map((c) => (c.x1 - c.x0 + 1) / 2));
    const m = mirrorCaps(on, mask.width, mask.height, spans, Math.ceil((half + 4) * sy));
    on = m.data;
    rows = m.height;
    top = m.top;
  }
  const off = new Uint8Array(on.length);
  for (let i = 0; i < on.length; i++) off[i] = 1 - on[i];
  const dIn = distanceTransform(on, mask.width, rows).data;
  const dOut = distanceTransform(off, mask.width, rows).data;
  const signed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i + top * mask.width;
    signed[i] = on[k] ? dIn[k] - 0.5 : 0.5 - dOut[k];
  }
  const grid = resizeFloat({ width: mask.width, height: mask.height, data: signed }, W, H).data;
  const s = (mask.width / W + mask.height / H) / 2;
  const smooth = blurBuffer(grid, W, H, 0.8);
  for (let i = 0; i < smooth.length; i++) smooth[i] /= s;
  return smooth;
}

function binarize(mask: ByteField): Uint8Array {
  const on = new Uint8Array(mask.data.length);
  for (let i = 0; i < on.length; i++) on[i] = mask.data[i] >= 128 ? 1 : 0;
  return on;
}

/** Flip as requested, crop tight to the object and shrink to a working size. */
function prepareRef(name: ViewName, v: ViewInput): PreparedRef | null {
  let image = v.image;
  let mask = v.mask;
  let depth = v.depth;
  let depthRect = v.depthRect ?? { x: 0, y: 0, width: v.image.width, height: v.image.height };
  if (v.flip) {
    image = flipRGBA(image);
    mask = flipByte(mask);
    if (depth) depth = flipFloat(depth);
    depthRect = { ...depthRect, x: v.image.width - depthRect.x - depthRect.width };
  }
  const box = maskBBox(mask);
  if (!box || box.width < 4 || box.height < 4) return null;
  const cropped = cropRGBA(image, box);
  const croppedMask = cropByte(mask, box);
  const croppedDepth = depth ? cropFloatFrame(depth, box, depthRect) : undefined;
  const s = Math.min(1, REF_MAX / Math.max(box.width, box.height));
  const w = Math.max(4, Math.round(box.width * s));
  const h = Math.max(4, Math.round(box.height * s));
  const img = resizeRGBA(cropped, w, h);
  const m = resizeByte(croppedMask, w, h);
  const on = binarize(m);
  const rows = rowSpans(on, w, h);
  const cols = colSpans(on, w, h);
  if (!rows || !cols) return null;
  return { name, image: img, mask: m, depth: croppedDepth, rows, cols, geometryOnly: !!v.geometryOnly };
}

/** Relief of a reference computed on its own grid (same density as the front grid). */
function refRelief(ref: PreparedRef, resolution: number): { relief: Relief; w: number; h: number; rows: Spans } | null {
  if (!ref.depth) return null;
  const s = resolution / Math.max(ref.image.width, ref.image.height);
  const w = Math.max(8, Math.round(ref.image.width * s));
  const h = Math.max(8, Math.round(ref.image.height * s));
  const on = binarize(resizeByte(ref.mask, w, h));
  const sil = analyseSilhouette(on, w, h);
  const relief = depthRelief(ref.depth, sil);
  const rows = rowSpans(on, w, h);
  if (!relief || !rows) return null;
  return { relief, w, h, rows };
}

export type ProgressFn = (stage: string, fraction: number) => void;

/**
 * Photo (+ optional reference views) -> closed, textured mesh.
 *
 *  1. Crop to the object and analyse its silhouette (distance + local thickness).
 *  2. Front surface = depth-network relief over the rim surface, blended with a
 *     circular-cross-section inflation prior.
 *  3. Back surface = back reference relief, mirror of the front, inflation or flat.
 *  4. Side/top references rescale the front-to-back extent per row/column.
 *  5. Mesh the two layers and stitch them with a side wall (watertight).
 *  6. Bake the atlas: front = the photo itself; back/sides from references.
 */
export function reconstruct(input: ReconstructInput, progress: ProgressFn = () => {}): MeshResult {
  const { front, settings } = input;
  const box = maskBBox(front.mask);
  if (!box) throw new Error('No object found in the image: the cut-out mask is empty.');
  const pad = Math.max(2, Math.round(Math.max(box.width, box.height) * 0.02));
  const crop = padRect(box, pad, front.image.width, front.image.height);
  const frontImage = cropRGBA(front.image, crop);
  const frontMask = cropByte(front.mask, crop);
  const frontDepth = front.depth
    ? cropFloatFrame(front.depth, crop, front.depthRect ?? { x: 0, y: 0, width: front.image.width, height: front.image.height })
    : undefined;

  progress('Analysing silhouette', 0.1);
  const g = settings.resolution / Math.max(crop.width, crop.height);
  const W = Math.max(8, Math.round(crop.width * g));
  const H = Math.max(8, Math.round(crop.height * g));
  const inside = binarize(resizeByte(frontMask, W, H));
  if (!inside.some((v) => v)) throw new Error('The object is too small for the chosen resolution.');
  // Flat ends (bottle base, cap top) keep their full thickness up to the outline.
  const caps = detectCaps(inside, W, H, frontMask);
  const signedDist = fineDistance(frontMask, W, H);
  const wallDist = caps.length ? fineDistance(frontMask, W, H, caps) : signedDist;
  const sil = analyseSilhouette(inside, W, H, wallDist, caps);
  const capW = capWeights(sil, signedDist);
  const rim = rimOffsets(sil, frontMask);
  const frontRows = rowSpans(inside, W, H)!;
  const frontCols = colSpans(inside, W, H)!;

  progress('Estimating front surface', 0.25);
  const relief = frontDepth ? depthRelief(frontDepth, sil) : null;
  const lum = settings.shadingDetail > 0 ? luminance(resizeRGBA(frontImage, W, H)).data : null;
  const shapeParams = {
    thickness: settings.thickness,
    depthStrength: settings.depthStrength,
    roundness: relief ? settings.roundness : 1,
    keepTilt: settings.keepTilt,
    smoothing: settings.smoothing,
    shadingDetail: settings.shadingDetail,
  };
  const fs = frontShape(sil, relief, lum, shapeParams);

  progress('Aligning reference views', 0.4);
  const refs: Partial<Record<ViewName, PreparedRef>> = {};
  for (const [name, view] of Object.entries(input.refs) as [ViewName, ViewInput | undefined][]) {
    if (!view) continue;
    const p = prepareRef(name, view);
    if (p) refs[name] = p;
  }
  const usedRefs = (Object.keys(refs) as ViewName[]).filter((k) => !refs[k]!.geometryOnly);
  const shapeOnlyRefs = (Object.keys(refs) as ViewName[]).filter((k) => refs[k]!.geometryOnly);

  // Back geometry.
  let backShape = settings.backShape;
  const backRelief = refs.back ? refRelief(refs.back, settings.resolution) : null;
  if (backShape === 'auto') backShape = backRelief ? 'reference' : relief ? 'mirror' : 'round';
  if (backShape === 'reference' && !backRelief) backShape = 'round';
  let hB: Float32Array;
  const n = W * H;
  if (backShape === 'reference' && backRelief) {
    hB = backFromReference(sil, frontRows, backRelief.relief, backRelief.rows, backRelief.w, backRelief.h, fs, shapeParams);
  } else if (backShape === 'mirror') {
    hB = new Float32Array(n);
    for (let i = 0; i < n; i++) hB[i] = Math.max(0, fs.hF[i]);
  } else if (backShape === 'round') {
    hB = new Float32Array(n);
    for (let i = 0; i < n; i++) hB[i] = settings.thickness * fs.infl[i];
  } else {
    hB = new Float32Array(n);
    const flat = Math.max(1, H * 0.01);
    for (let i = 0; i < n; i++) if (inside[i]) hB[i] = Math.min(flat, sil.dist[i]);
  }
  const hF = fs.hF;

  // Side and top photos fix the real depth of the object.
  const constraints: ExtentConstraint[] = [];
  const sideRefs = [refs.left, refs.right].filter((r): r is PreparedRef => !!r);
  if (sideRefs.length) {
    const ext = sideRefs.map((r) => extentFromReference(frontRows, r.rows));
    const values = new Float32Array(H);
    for (let j = 0; j < H; j++) values[j] = ext.reduce((a, e) => a + e[j], 0) / ext.length;
    constraints.push({ axis: 'rows', values });
  }
  if (refs.top) constraints.push({ axis: 'cols', values: extentFromReference(frontCols, refs.top.cols) });
  applyExtentConstraints(sil, hF, hB, constraints);

  progress('Building watertight mesh', 0.55);
  // Height factor for sliding a cap vertex by (ox, oy): the profile follows the distance to the walls.
  const wallRatio = (p: number, ox: number, oy: number) => {
    const i = p % W;
    const j = (p - i) / W;
    const wd = (x: number, y: number) => wallDist[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    const d = sil.dist[p] + ((wd(i + 1, j) - wd(i - 1, j)) / 2) * ox + ((wd(i, j + 1) - wd(i, j - 1)) / 2) * oy;
    return profileRatio(sil.dist[p], Math.max(0.05, d), sil.radius[p]);
  };
  // Keep a minimum wall thickness and a clean rim; allow front concavities inside.
  const minH = 0.35;
  const minT = Math.max(0.8, H * 0.004);
  const zF = new Float32Array(n);
  const zB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    let f = hF[i];
    let b = Math.max(minH, hB[i]);
    if (sil.dist[i] <= 2 || capW[i] > 0) f = Math.max(minH, f);
    // Rim vertices sit exactly on the outline, where the surface meets the rim;
    // on a cap they keep their height and the side wall becomes the flat face.
    if (rim.snapped[i]) {
      const k = capW[i] ? wallRatio(i, rim.offset[i * 2], rim.offset[i * 2 + 1]) : 1;
      f = minH + (Math.max(minH, f * k) - minH) * capW[i];
      b = minH + (Math.max(minH, b * k) - minH) * capW[i];
    }
    if (f + b < minT) b = minT - f;
    zF[i] = fs.zRim[i] + f;
    zB[i] = fs.zRim[i] - b;
  }

  const layout = atlasLayout(crop.width, crop.height, settings.textureSize);
  // Put the second and third vertex rings at exactly 1 and 2 px from the outline
  // (the first is already on it) and move their heights along the rim profile.
  const rings = ringOffsets(sil, signedDist, capW, wallDist);
  const edgeOffset = new Float32Array(rim.offset);
  for (let i = 0; i < n; i++) {
    if (!inside[i] || rim.snapped[i]) continue;
    const ox = rings.offset[i * 2];
    const oy = rings.offset[i * 2 + 1];
    if (!ox && !oy) continue;
    edgeOffset[i * 2] = ox;
    edgeOffset[i * 2 + 1] = oy;
    const r = profileRatio(sil.dist[i], rings.dist[i], sil.radius[i]);
    zF[i] = fs.zRim[i] + (zF[i] - fs.zRim[i]) * r;
    zB[i] = fs.zRim[i] - (fs.zRim[i] - zB[i]) * r;
  }
  const hFront = new Float32Array(n);
  const hBack = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hFront[i] = zF[i] - fs.zRim[i];
    hBack[i] = fs.zRim[i] - zB[i];
  }
  const normalF = layerNormals(sil, wallDist, hFront, fs.zRim, 1, rings.dist);
  const normalB = layerNormals(sil, wallDist, hBack, fs.zRim, -1, rings.dist);
  const mesh = buildTwoLayerMesh({
    gridW: W,
    gridH: H,
    inside,
    zF,
    zB,
    zRim: fs.zRim,
    layout,
    edgeOffset,
    edgeDir: rim.dir,
    normalF,
    normalB,
    cap: capW,
  });

  progress('Baking texture', 0.7);
  const backTex = refs.back && !refs.back.geometryOnly;
  let backTexture = settings.backTexture;
  if (backTexture === 'auto') backTexture = backTex ? 'reference' : 'tone';
  if (backTexture === 'reference' && !backTex) backTexture = 'tone';
  const texRef = (r: PreparedRef | undefined): TextureRef | undefined => {
    if (!r || r.geometryOnly) return undefined;
    const matched = matchColors(r.image, r.mask, frontImage, frontMask, settings.colorMatch);
    return { image: bleedReference(matched, r.mask), rows: r.rows, cols: r.cols };
  };
  const atlas = bakeAtlas({
    frontImage,
    frontMask,
    gridW: W,
    gridH: H,
    inside,
    zF,
    zB,
    layout,
    back: texRef(refs.back),
    left: texRef(refs.left),
    right: texRef(refs.right),
    top: texRef(refs.top),
    backTexture,
    sideBlend: settings.sideBlend,
    normalF,
    normalB,
  });

  progress('Finishing', 0.9);
  // Stand the model on y = 0 and record where the photo frame sits in world space.
  let minY = Infinity;
  for (let v = 1; v < mesh.positions.length; v += 3) minY = Math.min(minY, mesh.positions[v]);
  for (let v = 1; v < mesh.positions.length; v += 3) mesh.positions[v] -= minY;
  const halfW = W / H / 2;
  const frame = { left: -halfW, right: halfW, top: 0.5 - minY, bottom: -0.5 - minY };

  return {
    positions: mesh.positions,
    normals: mesh.normals,
    uvs: mesh.uvs,
    indices: mesh.indices,
    atlas,
    frontPhoto: frontImage,
    frame,
    stats: {
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
      gridWidth: W,
      gridHeight: H,
      usedDepth: !!relief,
      usedRefs,
      shapeOnlyRefs,
      backShape,
      backTexture,
      watertight: isWatertight(mesh.positions, mesh.indices),
    },
  };
}

export function limitFloat(f: FloatField, max: number): FloatField {
  const s = max / Math.max(f.width, f.height);
  if (s >= 1) return f;
  return resizeFloat(f, Math.max(1, Math.round(f.width * s)), Math.max(1, Math.round(f.height * s)));
}
