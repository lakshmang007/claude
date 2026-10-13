/** Where each half of the texture atlas lives, in atlas pixels. */
export interface AtlasLayout {
  width: number;
  height: number;
  front: { x: number; y: number; w: number; h: number };
  back: { x: number; y: number; w: number; h: number };
}

export interface TwoLayerInput {
  gridW: number;
  gridH: number;
  inside: Uint8Array;
  /** Front surface depth per grid pixel (grid px, +z towards the camera). */
  zF: Float32Array;
  /** Back surface depth per grid pixel (grid px). */
  zB: Float32Array;
  /** Depth of the silhouette rim, where the side wall is split between front and back texture. */
  zRim: Float32Array;
  layout: AtlasLayout;
  /**
   * Optional sub-pixel (dx, dy) shift per grid pixel, used to move rim
   * vertices onto the exact outline of the high-resolution cut-out. UVs follow
   * the positions, so the photo stays pinned to the same place.
   */
  edgeOffset?: Float32Array;
  /** Outward outline direction (image space) for rim pixels, used for smooth rim normals. */
  edgeDir?: Float32Array;
  /** Precomputed unit normals per grid pixel (3 floats) for the front and back layers. */
  normalF?: Float32Array;
  normalB?: Float32Array;
  /**
   * Per grid pixel, how much the outline there is a flat end (0..1). Where it
   * is, the side wall is a real face (bottle base, cap top), so it gets its own
   * rim vertices with the face's normal instead of sharing the layers' ones.
   */
  cap?: Float32Array;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  /** glTF convention: v grows downwards from the top of the atlas. */
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * Builds a closed mesh from two height layers over the silhouette: a front
 * surface carrying the photo, a back surface, and a thin side wall stitched
 * along every boundary edge (outer outline and holes alike).
 *
 * World units: the grid height is 1, x to the right, y up, z towards the
 * camera that took the photo. Grid pixel (i, j) has its centre at
 * texture coordinate ((i + .5) / gridW, (j + .5) / gridH) of the cropped photo.
 */
export function buildTwoLayerMesh(m: TwoLayerInput): MeshData {
  const { gridW: W, gridH: H, inside, zF, zB, zRim, layout, edgeOffset, edgeDir, normalF, normalB, cap } = m;
  const unit = 1 / H;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vF = new Int32Array(W * H).fill(-1);
  const vB = new Int32Array(W * H).fill(-1);

  // Continuous grid coordinates of a pixel's vertex (pixel centre plus optional rim snap).
  const gx = (p: number) => (p % W) + 0.5 + (edgeOffset ? edgeOffset[p * 2] : 0);
  const gy = (p: number) => Math.floor(p / W) + 0.5 + (edgeOffset ? edgeOffset[p * 2 + 1] : 0);
  const uvOf = (half: AtlasLayout['front'], p: number): [number, number] => [
    (half.x + (gx(p) / W) * half.w) / layout.width,
    (half.y + (gy(p) / H) * half.h) / layout.height,
  ];
  const xOf = (p: number) => (gx(p) - W / 2) * unit;
  const yOf = (p: number) => (H / 2 - gy(p)) * unit;

  let count = 0;
  const push = (x: number, y: number, z: number, u: number, v: number, n: [number, number, number]) => {
    positions.push(x, y, z);
    normals.push(n[0], n[1], n[2]);
    uvs.push(u, v);
    return count++;
  };

  /**
   * Normal of a height layer from its gradient (world x = i, y = -j); `sign`
   * +1 front, -1 back. Rim pixels lean towards the outline direction, where
   * the real surface turns away from the camera.
   */
  const at = (z: Float32Array, i: number, j: number) => (i >= 0 && j >= 0 && i < W && j < H && inside[j * W + i] ? z[j * W + i] : NaN);
  const layerNormal = (z: Float32Array, p: number, sign: 1 | -1): [number, number, number] => {
    const given = sign === 1 ? normalF : normalB;
    if (given) return [given[p * 3], given[p * 3 + 1], given[p * 3 + 2]];
    const i = p % W;
    const j = (p - i) / W;
    const c = z[p];
    const l = at(z, i - 1, j), r = at(z, i + 1, j), u = at(z, i, j - 1), d = at(z, i, j + 1);
    const dzdi = !Number.isNaN(l) && !Number.isNaN(r) ? (r - l) / 2 : !Number.isNaN(r) ? r - c : !Number.isNaN(l) ? c - l : 0;
    const dzdj = !Number.isNaN(u) && !Number.isNaN(d) ? (d - u) / 2 : !Number.isNaN(d) ? d - c : !Number.isNaN(u) ? c - u : 0;
    let nx = -sign * dzdi;
    let ny = sign * dzdj;
    let nz: number = sign;
    if (edgeDir && (edgeDir[p * 2] || edgeDir[p * 2 + 1])) {
      const len = Math.hypot(nx, ny, nz);
      nx = nx / len + 2 * edgeDir[p * 2];
      ny = ny / len - 2 * edgeDir[p * 2 + 1];
      nz = nz / len;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  };
  const wallNormal = (p: number): [number, number, number] => {
    if (edgeDir && (edgeDir[p * 2] || edgeDir[p * 2 + 1])) return [edgeDir[p * 2], -edgeDir[p * 2 + 1], 0];
    const f = layerNormal(zF, p, 1);
    const b = layerNormal(zB, p, -1);
    const x = f[0] + b[0];
    const y = f[1] + b[1];
    const len = Math.hypot(x, y) || 1;
    return [x / len, y / len, 0];
  };

  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p]) continue;
      const [fu, fv] = uvOf(layout.front, p);
      vF[p] = push(xOf(p), yOf(p), zF[p] * unit, fu, fv, layerNormal(zF, p, 1));
    }
  }
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = j * W + i;
      if (!inside[p]) continue;
      const [bu, bv] = uvOf(layout.back, p);
      vB[p] = push(xOf(p), yOf(p), zB[p] * unit, bu, bv, layerNormal(zB, p, -1));
    }
  }

  // Directed boundary edges of the front surface, keyed by undirected pair.
  const edgeCount = new Map<number, number>();
  const edgeFrom = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * W * H + b : b * W * H + a);
  const addFrontTri = (a: number, b: number, c: number) => {
    indices.push(vF[a], vF[b], vF[c]);
    indices.push(vB[a], vB[c], vB[b]);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = key(p, q);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      edgeFrom.set(k, p * W * H + q);
    }
  };

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      // a b
      // c d   (image orientation: j grows downwards)
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      const ia = inside[a], ib = inside[b], ic = inside[c], id = inside[d];
      const n = ia + ib + ic + id;
      if (n === 4) {
        // Split along the diagonal with the smaller depth jump.
        if (Math.abs(zF[b] - zF[c]) <= Math.abs(zF[a] - zF[d])) {
          addFrontTri(a, c, b);
          addFrontTri(b, c, d);
        } else {
          addFrontTri(a, c, d);
          addFrontTri(a, d, b);
        }
      } else if (n === 3) {
        if (!ia) addFrontTri(b, c, d);
        else if (!ib) addFrontTri(a, c, d);
        else if (!ic) addFrontTri(a, d, b);
        else addFrontTri(a, c, b);
      }
    }
  }

  // Side wall: front rim -> mid (front texture) and mid -> back rim (back texture).
  const boundary: [number, number][] = [];
  for (const [k, cnt] of edgeCount) {
    if (cnt !== 1) continue;
    const dir = edgeFrom.get(k)!;
    const p = Math.floor(dir / (W * H));
    boundary.push([p, dir - p * W * H]);
  }
  const isCap = (p: number) => !!cap && cap[p] >= 0.5;
  // A cap face follows the outline, so its normal is the outline's, smoothed
  // along it: the cut-out's pixel steps would otherwise show up as stripes.
  const capN = new Map<number, [number, number]>();
  const capNext = new Map<number, number[]>();
  for (const [p, q] of boundary) {
    if (!isCap(p) || !isCap(q)) continue;
    // Outward normal of the wall over the directed edge p -> q (length-weighted).
    const nx = yOf(q) - yOf(p);
    const ny = xOf(p) - xOf(q);
    for (const [v, u] of [[p, q], [q, p]]) {
      const n = capN.get(v) ?? [0, 0];
      n[0] += nx;
      n[1] += ny;
      capN.set(v, n);
      const list = capNext.get(v) ?? [];
      list.push(u);
      capNext.set(v, list);
    }
  }
  const unit2 = (n: [number, number]): [number, number] => {
    const l = Math.hypot(n[0], n[1]) || 1;
    return [n[0] / l, n[1] / l];
  };
  for (let pass = 0; pass < 4; pass++) {
    const prev = new Map<number, [number, number]>();
    for (const [v, n] of capN) prev.set(v, unit2(n));
    for (const [v, n] of prev) {
      const sum: [number, number] = [2 * n[0], 2 * n[1]];
      for (const u of capNext.get(v)!) {
        sum[0] += prev.get(u)![0];
        sum[1] += prev.get(u)![1];
      }
      capN.set(v, unit2(sum));
    }
  }
  // Neither photo sees a cap face. Colour it from the photo just inside its outline,
  // drawn towards the cap's middle so the photo's vertical streaks and rim shading
  // do not run across it, and use that on both halves so the face has no seam.
  const capUV = new Map<number, [number, number]>();
  const seen = new Set<number>();
  for (const start of capN.keys()) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (const u of capNext.get(v)!) {
        if (seen.has(u)) continue;
        seen.add(u);
        stack.push(u);
      }
    }
    let cx = 0, cy = 0, nx = 0, ny = 0;
    for (const v of comp) {
      cx += gx(v);
      cy += gy(v);
      nx += capN.get(v)![0];
      ny += capN.get(v)![1];
    }
    cx /= comp.length;
    cy /= comp.length;
    const nl = Math.hypot(nx, ny) || 1;
    // capN is in world axes (y up); inwards on the grid (y down) is (-nx, ny).
    const ix = -nx / nl;
    const iy = ny / nl;
    for (const v of comp) {
      const px = cx + (gx(v) - cx) * 0.3 + ix * 2.5;
      const py = cy + (gy(v) - cy) * 0.3 + iy * 2.5;
      capUV.set(v, [(layout.front.x + (px / W) * layout.front.w) / layout.width, (layout.front.y + (py / H) * layout.front.h) / layout.height]);
    }
  }
  const sideNormal = (p: number): [number, number, number] => {
    const n = capN.get(p);
    return n ? [n[0], n[1], 0] : wallNormal(p);
  };
  const midF = new Map<number, number>();
  const midB = new Map<number, number>();
  const midZ = (p: number) => Math.min(zF[p], Math.max(zB[p], zRim[p])) * unit;
  const getMid = (p: number, back: boolean) => {
    const map = back ? midB : midF;
    let v = map.get(p);
    if (v === undefined) {
      const [u, vv] = capUV.get(p) ?? uvOf(back ? layout.back : layout.front, p);
      v = push(xOf(p), yOf(p), midZ(p), u, vv, sideNormal(p));
      map.set(p, v);
    }
    return v;
  };
  // Cap faces meet the front and back at a crease: their rim vertices are their own.
  const capF = new Map<number, number>();
  const capB = new Map<number, number>();
  const capRim = (p: number, back: boolean) => {
    const map = back ? capB : capF;
    let v = map.get(p);
    if (v === undefined) {
      const [u, vv] = capUV.get(p) ?? uvOf(back ? layout.back : layout.front, p);
      v = push(xOf(p), yOf(p), (back ? zB[p] : zF[p]) * unit, u, vv, sideNormal(p));
      map.set(p, v);
    }
    return v;
  };
  for (const [p, q] of boundary) {
    const flat = isCap(p) && isCap(q);
    const fp = flat ? capRim(p, false) : vF[p];
    const fq = flat ? capRim(q, false) : vF[q];
    const bp = flat ? capRim(p, true) : vB[p];
    const bq = flat ? capRim(q, true) : vB[q];
    const mpF = getMid(p, false), mqF = getMid(q, false);
    const mpB = getMid(p, true), mqB = getMid(q, true);
    indices.push(fq, fp, mpF, fq, mpF, mqF);
    indices.push(mqB, mpB, bp, mqB, bp, bq);
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
}

/**
 * Checks that the mesh is closed and consistently oriented once coincident
 * vertices (UV seams) are welded: every directed edge must be matched by
 * exactly one opposite edge.
 */
export function isWatertight(positions: Float32Array, indices: Uint32Array): boolean {
  const weld = new Map<string, number>();
  const id = new Int32Array(positions.length / 3);
  for (let v = 0; v < id.length; v++) {
    const k = `${positions[v * 3].toFixed(6)},${positions[v * 3 + 1].toFixed(6)},${positions[v * 3 + 2].toFixed(6)}`;
    let w = weld.get(k);
    if (w === undefined) {
      w = weld.size;
      weld.set(k, w);
    }
    id[v] = w;
  }
  const directed = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = id[indices[t + e]];
      const b = id[indices[t + ((e + 1) % 3)]];
      if (a === b) continue;
      const k = `${a}>${b}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  for (const [k, c] of directed) {
    if (c !== 1) return false;
    const [a, b] = k.split('>');
    if (directed.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}
