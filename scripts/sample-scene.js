// Browser half of scripts/render-samples.mjs: builds the demo objects with
// three.js and renders studio "product photos" and ground-truth turntable views.
// Loaded through an import map that points `three` at node_modules.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';

const SERIF = 'Caladea, "DejaVu Serif", Georgia, serif';
const SANS = 'Inter, "DejaVu Sans", Arial, sans-serif';
const DEG = Math.PI / 180;
// Label stock: kept well away from the backdrop's warm grey so a colour-key cut-out does not punch it out.
const PARCHMENT = '#efd8a2';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
const pmrem = new THREE.PMREMGenerator(renderer);
// Same environment as the app's viewer, so ground truth and reconstruction are lit alike.
const viewerEnvironment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const studioEnvironment = pmrem.fromScene(studioRoom(), 0.04).texture;

/** RoomEnvironment plus two tall strip softboxes behind the product, for the rim reflections of bottle shots. */
function studioRoom() {
  const room = new RoomEnvironment();
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(14) });
  for (const side of [-1, 1]) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), glow);
    // RoomEnvironment sits at y = -3.5, so local y 4.5 is just above the product.
    box.position.set(side * 6.5, 4.5, -6.5);
    box.rotation.y = (side * 3 * Math.PI) / 4;
    box.scale.set(1.6, 9, 0.1);
    room.add(box);
  }
  return room;
}

// ---------------------------------------------------------------- helpers

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function canvas2d(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return [canvas, canvas.getContext('2d')];
}

function toTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAnisotropy;
  return t;
}

/** Paper stock: flat colour with faint fibres so print does not look like vector art. */
function paper(ctx, w, h, color, seed) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  const rand = seeded(seed);
  for (let i = 0; i < (w * h) / 300; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2.5, 1 + rand() * 1.5);
  }
}

function text(ctx, str, x, y, font, color, { align = 'center', spacing = 0 } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(str, x, y);
  ctx.letterSpacing = '0px';
}

function wrap(ctx, str, x, y, maxWidth, lineHeight, font, color) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  let line = '';
  for (const word of str.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
      line = word;
    } else {
      line = next;
    }
  }
  ctx.fillText(line, x, y);
  return y + lineHeight;
}

/** computeVertexNormals, then average across seams and poles where vertices are duplicated. */
function smoothNormals(geometry) {
  geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const groups = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { n: new THREE.Vector3(), idx: [] }));
    g.n.x += nor.getX(i);
    g.n.y += nor.getY(i);
    g.n.z += nor.getZ(i);
    g.idx.push(i);
  }
  for (const g of groups.values()) {
    g.n.normalize();
    for (const i of g.idx) nor.setXYZ(i, g.n.x, g.n.y, g.n.z);
  }
  return geometry;
}

function lathe(points, segments = 128) {
  // Seam at the back (phiStart = pi) keeps it out of the main photo.
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments, Math.PI, Math.PI * 2);
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Decal projected onto `mesh` where a ray from `from` along `dir` hits it. */
function decal(mesh, from, dir, size, material) {
  mesh.updateMatrixWorld(true);
  const hit = new THREE.Raycaster(from, dir.clone().normalize()).intersectObject(mesh)[0];
  if (!hit) throw new Error('decal ray missed');
  const normal = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
  const aim = new THREE.Object3D();
  aim.position.copy(hit.point);
  aim.lookAt(hit.point.clone().add(normal));
  const geometry = new DecalGeometry(mesh, hit.point, aim.rotation, new THREE.Vector3(size, size, size));
  return new THREE.Mesh(geometry, material);
}

function decalMaterial(canvas, base) {
  return new THREE.MeshPhysicalMaterial({
    ...base,
    map: toTexture(canvas),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
}

// ---------------------------------------------------------------- artwork

function flame(ctx, cx, base, w, h, color) {
  const P = (x, y) => [cx + x * w, base - y * h];
  ctx.beginPath();
  ctx.moveTo(...P(0, 0));
  ctx.bezierCurveTo(...P(-0.52, 0), ...P(-0.62, 0.36), ...P(-0.44, 0.6));
  ctx.bezierCurveTo(...P(-0.34, 0.74), ...P(-0.24, 0.8), ...P(-0.24, 0.98));
  ctx.bezierCurveTo(...P(-0.08, 0.86), ...P(-0.02, 0.78), ...P(0.02, 0.68));
  ctx.bezierCurveTo(...P(0.1, 0.86), ...P(0.24, 0.92), ...P(0.16, 1.14));
  ctx.bezierCurveTo(...P(0.44, 0.9), ...P(0.62, 0.56), ...P(0.52, 0.3));
  ctx.bezierCurveTo(...P(0.46, 0.1), ...P(0.28, 0), ...P(0, 0));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function chili(ctx, x, y, s, filled) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.35);
  ctx.beginPath();
  ctx.moveTo(-0.42 * s, -0.1 * s);
  ctx.quadraticCurveTo(0.15 * s, -0.32 * s, 0.5 * s, 0.26 * s);
  ctx.quadraticCurveTo(0.02 * s, 0.06 * s, -0.42 * s, 0.14 * s);
  ctx.closePath();
  ctx.lineWidth = s * 0.07;
  ctx.strokeStyle = '#8a1c12';
  if (filled) {
    ctx.fillStyle = '#c62a17';
    ctx.fill();
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.42 * s, 0.02 * s);
  ctx.quadraticCurveTo(-0.58 * s, -0.02 * s, -0.62 * s, -0.2 * s);
  ctx.strokeStyle = '#3f6b2a';
  ctx.lineWidth = s * 0.09;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

function ean13(ctx, digits12, x, y, moduleW, barH) {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const R = L.map((c) => [...c].map((b) => (b === '0' ? '1' : '0')).join(''));
  const G = R.map((c) => [...c].reverse().join(''));
  const parity = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const d = [...digits12].map(Number);
  const sum = d.reduce((a, v, i) => a + v * (i % 2 ? 3 : 1), 0);
  d.push((10 - (sum % 10)) % 10);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (parity[d[0]][i - 1] === 'L' ? L : G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]];
  bits += '101';
  const guard = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
  ctx.fillStyle = '#111';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') ctx.fillRect(x + i * moduleW, y, moduleW, guard.has(i) ? barH + moduleW * 5 : barH);
  }
  const font = `500 ${Math.round(moduleW * 9)}px ${SANS}`;
  const ty = y + barH + moduleW * 9.5;
  text(ctx, String(d[0]), x - moduleW * 5, ty, font, '#111');
  text(ctx, d.slice(1, 7).join(''), x + moduleW * 24, ty, font, '#111', { spacing: moduleW * 2.2 });
  text(ctx, d.slice(7).join(''), x + moduleW * 70, ty, font, '#111', { spacing: moduleW * 2.2 });
}

function hotSauceFrontLabel(w, h) {
  const [c, ctx] = canvas2d(w, h);
  paper(ctx, w, h, PARCHMENT, 11);
  ctx.strokeStyle = '#2a211b';
  ctx.lineWidth = 7;
  ctx.strokeRect(26, 26, w - 52, h - 52);
  ctx.lineWidth = 2;
  ctx.strokeRect(44, 44, w - 88, h - 88);
  const cx = w / 2;
  text(ctx, 'EMBER & CO.', cx, 205, `700 128px ${SERIF}`, '#241c17', { spacing: 12 });
  ctx.fillStyle = '#8a1c12';
  ctx.fillRect(cx - 300, 240, 600, 3);
  text(ctx, 'SMALL BATCH  ·  EST. 2014', cx, 292, `600 34px ${SANS}`, '#8a1c12', { spacing: 7 });

  // Flame emblem on a dark medallion.
  ctx.beginPath();
  ctx.arc(cx, 560, 200, 0, Math.PI * 2);
  ctx.fillStyle = '#241c17';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#c9a45c';
  ctx.beginPath();
  ctx.arc(cx, 560, 182, 0, Math.PI * 2);
  ctx.stroke();
  flame(ctx, cx, 712, 270, 300, '#d9381e');
  flame(ctx, cx + 6, 712, 190, 215, '#f07a1a');
  flame(ctx, cx + 10, 712, 110, 125, '#ffc93c');

  text(ctx, 'Smoked', cx, 880, `italic 400 104px ${SERIF}`, '#8a1c12');
  text(ctx, 'Habanero', cx, 1048, `700 196px ${SERIF}`, '#241c17');
  text(ctx, 'HEAT', cx - 190, 1150, `700 34px ${SANS}`, '#241c17', { spacing: 6 });
  for (let i = 0; i < 5; i++) chili(ctx, cx - 70 + i * 74, 1138, 62, i < 4);
  ctx.fillStyle = '#241c17';
  ctx.fillRect(46, h - 190, w - 92, 144);
  text(ctx, 'Hot Sauce · 150 ml', cx, h - 100, `500 52px ${SANS}`, PARCHMENT, { spacing: 3 });
  return c;
}

function hotSauceBackLabel(w, h) {
  const [c, ctx] = canvas2d(w, h);
  paper(ctx, w, h, PARCHMENT, 12);
  ctx.strokeStyle = '#2a211b';
  ctx.lineWidth = 5;
  ctx.strokeRect(24, 24, w - 48, h - 48);
  const x0 = Math.round(w * 0.17);
  const colW = w - 2 * x0;
  text(ctx, 'Ingredients', x0, 140, `700 84px ${SERIF}`, '#241c17', { align: 'left' });
  let y = wrap(
    ctx,
    'Habanero peppers, distilled vinegar, smoked red jalapeños, carrots, onion, garlic, lime juice, sea salt, spices.',
    x0, 214, colW, 56, `500 44px ${SANS}`, '#2b2622',
  );

  // Nutrition facts panel.
  const top = y - 12;
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 5;
  ctx.strokeRect(x0, top, colW, 500);
  text(ctx, 'Nutrition Facts', x0 + 20, top + 74, `800 62px ${SANS}`, '#111', { align: 'left' });
  text(ctx, 'Serving size 1 tsp (5 ml)', x0 + 20, top + 124, `500 36px ${SANS}`, '#111', { align: 'left' });
  ctx.fillStyle = '#111';
  ctx.fillRect(x0 + 12, top + 144, colW - 24, 14);
  const rows = [['Calories', '0', ''], ['Total Fat', '0 g', '0%'], ['Sodium', '110 mg', '5%'], ['Total Carb.', '1 g', '0%'], ['Sugars', '0 g', ''], ['Protein', '0 g', '']];
  rows.forEach(([k, v, p], i) => {
    const ry = top + 206 + i * 48;
    text(ctx, `${k}  ${v}`, x0 + 20, ry, `${i === 0 ? 800 : 500} 36px ${SANS}`, '#111', { align: 'left' });
    if (p) text(ctx, p, x0 + colW - 20, ry, `700 36px ${SANS}`, '#111', { align: 'right' });
    ctx.fillRect(x0 + 12, ry + 14, colW - 24, 2);
  });

  ean13(ctx, '084512309172', w / 2 - 95 * 2.3, top + 540, 4.6, 140);
  text(ctx, 'Shake well · Refrigerate after opening', w / 2, h - 104, `600 34px ${SANS}`, '#2b2622');
  text(ctx, 'Ember & Co. · Austin, TX 78702', w / 2, h - 58, `500 32px ${SANS}`, '#2b2622');
  return c;
}

function neckBand(w, h) {
  const [c, ctx] = canvas2d(w, h);
  paper(ctx, w, h, '#241c17', 13);
  ctx.fillStyle = '#c9a45c';
  ctx.fillRect(0, 14, w, 5);
  ctx.fillRect(0, h - 19, w, 5);
  for (let i = 0; i < 3; i++) text(ctx, 'EMBER & CO.  ✦', (i + 0.5) * (w / 3), h / 2 + 24, `700 64px ${SERIF}`, '#c9a45c', { spacing: 6 });
  return c;
}

function shampooLabel(w, h) {
  const [c, ctx] = canvas2d(w, h);
  paper(ctx, w, h, '#f7fbff', 21);
  const cx = w / 2;
  ctx.fillStyle = '#1f5fbf';
  ctx.beginPath();
  ctx.moveTo(cx, 120);
  ctx.bezierCurveTo(cx + 120, 300, cx + 120, 420, cx, 420);
  ctx.bezierCurveTo(cx - 120, 420, cx - 120, 300, cx, 120);
  ctx.fill();
  text(ctx, 'AQUA PURE', cx, 560, `800 120px ${SANS}`, '#173e7a', { spacing: 4 });
  text(ctx, 'Hydrating Shampoo', cx, 660, `500 64px ${SANS}`, '#1f5fbf');
  text(ctx, 'with sea minerals', cx, 740, `italic 400 48px ${SERIF}`, '#4b6587');
  text(ctx, '300 ml', cx, h - 90, `600 52px ${SANS}`, '#173e7a');
  return c;
}

function starDecal() {
  const [c, ctx] = canvas2d(512, 512);
  const path = () => {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 92 : 220;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(256 + r * Math.cos(a), 270 + r * Math.sin(a));
    }
    ctx.closePath();
  };
  path();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 34;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#1d4ed8';
  ctx.fill();
  return c;
}

function heartDecal() {
  const [c, ctx] = canvas2d(512, 512);
  ctx.beginPath();
  ctx.moveTo(256, 452);
  ctx.bezierCurveTo(120, 350, 40, 270, 60, 170);
  ctx.bezierCurveTo(80, 70, 210, 50, 256, 150);
  ctx.bezierCurveTo(302, 50, 432, 70, 452, 170);
  ctx.bezierCurveTo(472, 270, 392, 350, 256, 452);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 34;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = '#dc2626';
  ctx.fill();
  return c;
}

function eyeDecal() {
  const [c, ctx] = canvas2d(256, 256);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(128, 128, 100, 118, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#111111';
  ctx.beginPath();
  ctx.ellipse(128, 136, 66, 80, 0, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

// ---------------------------------------------------------------- objects

function buildHotSauce() {
  const group = new THREE.Group();
  const R = 0.32;
  const profile = [[0, 0.012], [0.22, 0]];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    profile.push([0.27 + 0.05 * Math.sin(a), 0.05 - 0.05 * Math.cos(a)]);
  }
  profile.push([R, 0.5], [R, 1.0]);
  for (let i = 1; i <= 24; i++) {
    const s = i / 24;
    profile.push([0.105 + (R - 0.105) * (0.5 + 0.5 * Math.cos(Math.PI * s)), 1.0 + 0.38 * s]);
  }
  profile.push([0.105, 1.79], [0.09, 1.8], [0, 1.8]);
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x5c0c06, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 1,
  });
  group.add(shadowed(new THREE.Mesh(lathe(profile, 160), glass)));

  const capProfile = [[0.1, 1.745], [0.128, 1.745], [0.132, 1.755]];
  capProfile.push([0.132, 1.95]);
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    capProfile.push([0.112 + 0.02 * Math.cos(a), 1.95 + 0.02 * Math.sin(a)]);
  }
  capProfile.push([0, 1.97]);
  const cap = lathe(capProfile, 240);
  const p = cap.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < 1.758 || y > 1.946) continue;
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    const phi = Math.atan2(x, z);
    const rr = r + 0.0035 * Math.cos(phi * 60);
    p.setXYZ(i, (x / r) * rr, y, (z / r) * rr);
  }
  smoothNormals(cap);
  group.add(shadowed(new THREE.Mesh(cap, new THREE.MeshPhysicalMaterial({ color: 0x161616, roughness: 0.55 }))));

  const labelMat = (canvas) => new THREE.MeshPhysicalMaterial({ map: toTexture(canvas), roughness: 0.62, clearcoat: 0.12, clearcoatRoughness: 0.3 });
  const y0 = 0.14;
  const y1 = 0.86;
  const rl = R + 0.0016;
  const front = 140 * DEG;
  const back = 120 * DEG;
  const pxPerUnit = 1376 / (y1 - y0);
  const frontGeo = new THREE.CylinderGeometry(rl, rl, y1 - y0, 128, 1, true, -front / 2, front);
  const frontMesh = shadowed(new THREE.Mesh(frontGeo, labelMat(hotSauceFrontLabel(Math.round(rl * front * pxPerUnit), 1376))));
  frontMesh.position.y = (y0 + y1) / 2;
  const backGeo = new THREE.CylinderGeometry(rl, rl, y1 - y0, 128, 1, true, Math.PI - back / 2, back);
  const backMesh = shadowed(new THREE.Mesh(backGeo, labelMat(hotSauceBackLabel(Math.round(rl * back * pxPerUnit), 1376))));
  backMesh.position.y = (y0 + y1) / 2;
  const rn = 0.105 + 0.0014;
  const band = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(rn, rn, 0.13, 96, 1, true), labelMat(neckBand(2048, 300))));
  band.position.y = 1.61 + 0.065;
  group.add(frontMesh, backMesh, band);
  return group;
}

function buildDuck() {
  const group = new THREE.Group();
  const yellow = { color: 0xffcc12, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12 };
  const bodyGeo = new THREE.SphereGeometry(1, 192, 128);
  const p = bodyGeo.attributes.position;
  // The duck faces -x (beak), so its left side faces +z, towards the main photo's camera.
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    let X = x * 1.02;
    let Y = y * 0.62;
    let Z = z * 0.8;
    if (Y < 0) Y *= 0.68;
    const tail = smoothstep(0.05, 1, x);
    const upper = smoothstep(-0.25, 0.75, y);
    Y += 0.62 * tail * tail * upper;
    X += 0.1 * tail * upper;
    Z *= 1 - 0.55 * tail * tail * smoothstep(-0.4, 0.6, y);
    const chest = smoothstep(0.1, 1, -x) * smoothstep(-0.6, 0.4, y);
    X -= 0.06 * chest;
    // A raised wing on each side, swept up towards the tail.
    const wx = (x - 0.22) / 0.46;
    const wy = (y - 0.2 - 0.35 * Math.max(0, x - 0.22)) / 0.3;
    const wing = (1 - smoothstep(0.7, 1, Math.hypot(wx, wy))) * smoothstep(0.45, 0.75, Math.abs(z));
    Z += Math.sign(z) * 0.035 * wing;
    p.setXYZ(i, X, Y + 0.42, Z);
  }
  smoothNormals(bodyGeo);
  const body = shadowed(new THREE.Mesh(bodyGeo, new THREE.MeshPhysicalMaterial(yellow)));
  group.add(body);

  const headC = new THREE.Vector3(-0.46, 1.27, 0);
  const head = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.47, 128, 96), new THREE.MeshPhysicalMaterial(yellow)));
  head.position.copy(headC);
  head.scale.set(1, 0.96, 0.94);
  group.add(head);

  const orange = new THREE.MeshPhysicalMaterial({ color: 0xff7a12, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.15 });
  const upperBeak = shadowed(new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), orange));
  upperBeak.scale.set(0.33, 0.11, 0.25);
  upperBeak.position.set(headC.x - 0.4, headC.y - 0.07, 0);
  upperBeak.rotation.z = 0.12;
  const lowerBeak = shadowed(new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), orange));
  lowerBeak.scale.set(0.27, 0.075, 0.2);
  lowerBeak.position.set(headC.x - 0.36, headC.y - 0.17, 0);
  lowerBeak.rotation.z = -0.08;
  group.add(upperBeak, lowerBeak);

  group.updateMatrixWorld(true);
  const eyeMat = decalMaterial(eyeDecal(), { roughness: 0.15, clearcoat: 1 });
  for (const side of [1, -1]) {
    const dir = new THREE.Vector3(-0.5, 0.36, 0.79 * side).normalize();
    group.add(decal(head, headC.clone().addScaledVector(dir, 2), dir.clone().negate(), 0.17, eyeMat));
  }
  const paint = { roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12 };
  group.add(decal(body, new THREE.Vector3(-0.5, 0.42, 3), new THREE.Vector3(0, 0, -1), 0.34, decalMaterial(starDecal(), paint)));
  group.add(decal(body, new THREE.Vector3(-0.5, 0.42, -3), new THREE.Vector3(0, 0, 1), 0.32, decalMaterial(heartDecal(), paint)));
  return group;
}

function buildShampoo() {
  const group = new THREE.Group();
  const profile = [[0, 0.01], [0.3, 0]];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    profile.push([0.3 + 0.06 * Math.sin(a), 0.06 - 0.06 * Math.cos(a)]);
  }
  profile.push([0.36, 0.95]);
  for (let i = 1; i <= 16; i++) {
    const s = i / 16;
    profile.push([0.15 + 0.21 * Math.cos((s * Math.PI) / 2), 0.95 + 0.25 * Math.sin((s * Math.PI) / 2)]);
  }
  profile.push([0.15, 1.24], [0, 1.24]);
  const body = lathe(profile, 128);
  body.scale(1, 1, 0.55);
  group.add(shadowed(new THREE.Mesh(body, new THREE.MeshPhysicalMaterial({ color: 0x1f5cc0, roughness: 0.28, clearcoat: 0.5 }))));
  const capProfile = [[0, 1.2], [0.17, 1.2], [0.175, 1.21], [0.175, 1.44]];
  for (let i = 1; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2);
    capProfile.push([0.145 + 0.03 * Math.cos(a), 1.44 + 0.03 * Math.sin(a)]);
  }
  capProfile.push([0, 1.47]);
  const cap = lathe(capProfile, 96);
  cap.scale(1, 1, 0.8);
  group.add(shadowed(new THREE.Mesh(cap, new THREE.MeshPhysicalMaterial({ color: 0xf4f4f2, roughness: 0.35, clearcoat: 0.3 }))));
  const arc = 110 * DEG;
  const labelGeo = new THREE.CylinderGeometry(0.3625, 0.3625, 0.62, 96, 1, true, -arc / 2, arc);
  labelGeo.scale(1, 1, 0.55);
  const label = shadowed(new THREE.Mesh(labelGeo, new THREE.MeshPhysicalMaterial({ map: toTexture(shampooLabel(1024, 920)), roughness: 0.4, clearcoat: 0.4 })));
  label.position.y = 0.5;
  group.add(label);
  return group;
}

function buildMug() {
  const group = new THREE.Group();
  const profile = [[0, 0.004], [0.36, 0]];
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * (Math.PI / 2);
    profile.push([0.36 + 0.03 * Math.sin(a), 0.03 - 0.03 * Math.cos(a)]);
  }
  profile.push([0.4, 0.88]);
  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * Math.PI;
    profile.push([0.38 + 0.02 * Math.cos(a), 0.88 + 0.02 * Math.sin(a)]);
  }
  profile.push([0.36, 0.1], [0.3, 0.07], [0, 0.07]);
  const ceramic = new THREE.MeshPhysicalMaterial({ color: 0x2b7a4b, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide });
  group.add(shadowed(new THREE.Mesh(lathe(profile, 128), ceramic)));
  const handle = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.05, 32, 64, Math.PI), ceramic));
  handle.rotation.z = -Math.PI / 2;
  handle.scale.set(1.25, 1, 1);
  handle.position.set(0.37, 0.46, 0);
  group.add(handle);
  return group;
}

const BUILDERS = { 'hot-sauce': buildHotSauce, 'rubber-duck': buildDuck, shampoo: buildShampoo, mug: buildMug };

// ---------------------------------------------------------------- scene

/** Soft contact shadow: the object's underside seen from the ground, blurred (after three.js' contact shadow example). */
class ContactShadow {
  constructor({ width = 3, height = 0.5, blur = 2, darkness = 1, opacity = 0.5, resolution = 512 }) {
    this.blurAmount = blur;
    this.group = new THREE.Group();
    this.rt = new THREE.WebGLRenderTarget(resolution, resolution);
    this.rtBlur = new THREE.WebGLRenderTarget(resolution, resolution);
    this.rt.texture.generateMipmaps = false;
    this.rtBlur.texture.generateMipmaps = false;
    const plane = new THREE.PlaneGeometry(width, width).rotateX(Math.PI / 2);
    this.plane = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: this.rt.texture, opacity, transparent: true, depthWrite: false }));
    this.plane.renderOrder = 1;
    this.plane.scale.y = -1;
    this.blurPlane = new THREE.Mesh(plane);
    this.blurPlane.visible = false;
    this.camera = new THREE.OrthographicCamera(-width / 2, width / 2, width / 2, -width / 2, 0, height);
    this.camera.rotation.x = Math.PI / 2;
    this.group.add(this.plane, this.blurPlane, this.camera);
    this.depth = new THREE.MeshDepthMaterial();
    this.depth.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = { value: darkness };
      shader.fragmentShader = `uniform float darkness;\n${shader.fragmentShader.replace(
        'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
        'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );',
      )}`;
    };
    this.depth.depthTest = false;
    this.depth.depthWrite = false;
    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.hBlur.depthTest = false;
    this.vBlur.depthTest = false;
  }

  update(scene, hide) {
    const visible = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    scene.overrideMaterial = this.depth;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = null;
    this.blur(this.blurAmount);
    this.blur(this.blurAmount * 0.4);
    renderer.setRenderTarget(null);
    renderer.setClearAlpha(clearAlpha);
    hide.forEach((o, i) => (o.visible = visible[i]));
  }

  blur(amount) {
    this.blurPlane.visible = true;
    this.blurPlane.material = this.hBlur;
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(this.rtBlur);
    renderer.render(this.blurPlane, this.camera);
    this.blurPlane.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.blurPlane, this.camera);
    this.blurPlane.visible = false;
  }
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(17, 1, 0.05, 100);

// Studio rig, fixed to the camera: products are turned on a turntable in front of it.
const studio = new THREE.Group();
const key = new THREE.DirectionalLight(0xfff3e6, 2.2);
key.position.set(-2.6, 3.6, 3.4);
key.target.position.set(0, 0.45, 0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 1.2, bottom: -1.2, near: 0.5, far: 12 });
key.shadow.radius = 3;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.012;
const fill = new THREE.DirectionalLight(0xe9f0ff, 0.45);
fill.position.set(3.5, 1.2, 2.5);
const rim = new THREE.DirectionalLight(0xffffff, 1.4);
rim.position.set(1.8, 3, -3.5);
studio.add(key, key.target, fill, rim);
// Kept light (the photo is composited in sRGB): a darker core would be keyed in
// with the object by the app's colour-key cut-out.
const contactTight = new ContactShadow({ height: 0.1, blur: 1.2, darkness: 1.1, opacity: 0.14 });
const contactSoft = new ContactShadow({ height: 0.55, blur: 6, darkness: 1, opacity: 0.1 });
studio.add(contactTight.group, contactSoft.group);
scene.add(studio);

const objects = new Map();

/** Object normalised to height 1, base on y = 0, bounding box centred on x = z = 0. */
function getObject(id) {
  let o = objects.get(id);
  if (o) return o;
  const raw = BUILDERS[id]();
  raw.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(raw, true);
  const s = 1 / (box.max.y - box.min.y);
  raw.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const norm = new THREE.Group();
  norm.scale.setScalar(s);
  norm.add(raw);
  const root = new THREE.Group();
  root.add(norm);
  root.updateMatrixWorld(true);
  const nbox = new THREE.Box3().setFromObject(root, true);
  o = { root, box: { min: nbox.min.toArray(), max: nbox.max.toArray() } };
  objects.set(id, o);
  return o;
}

function show(id) {
  for (const [k, o] of objects) if (k !== id && o.root.parent) scene.remove(o.root);
  const o = getObject(id);
  if (!o.root.parent) scene.add(o.root);
  return o;
}

function worldPoints(root) {
  const pts = [];
  root.updateMatrixWorld(true);
  root.traverse((m) => {
    if (!m.isMesh) return;
    const p = m.geometry.attributes.position;
    const step = Math.max(1, Math.floor(p.count / 20000));
    for (let i = 0; i < p.count; i += step) pts.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld));
  });
  return pts;
}

function ndcBounds(pts) {
  const v = new THREE.Vector3();
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of pts) {
    v.copy(p).project(camera);
    b.minX = Math.min(b.minX, v.x);
    b.maxX = Math.max(b.maxX, v.x);
    b.minY = Math.min(b.minY, v.y);
    b.maxY = Math.max(b.maxY, v.y);
  }
  return b;
}

/** Point the camera along (azimuth 0, `el`) and move it until the object fills `fill` of the frame, centred. */
function frame(root, el, fill) {
  const pts = worldPoints(root);
  const top = el >= 89.9;
  const dir = top ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, Math.sin(el * DEG), Math.cos(el * DEG));
  const up = top ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const target = new THREE.Box3().setFromPoints(pts).getCenter(new THREE.Vector3());
  const right = new THREE.Vector3();
  const camUp = new THREE.Vector3();
  let dist = 6;
  let b;
  for (let it = 0; it < 8; it++) {
    camera.up.copy(up);
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    b = ndcBounds(pts);
    const half = dist * Math.tan((camera.fov * DEG) / 2);
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, ((b.minX + b.maxX) / 2) * half * camera.aspect).addScaledVector(camUp, ((b.minY + b.maxY) / 2) * half);
    dist *= Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2 / fill;
  }
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return { bounds: ndcBounds(pts), distance: dist, target: target.toArray() };
}

/** Seamless light-grey sweep: brightest behind the product, falling off to the corners. */
function backdrop(ctx, w, h) {
  const g = ctx.createRadialGradient(w * 0.5, h * 0.44, 0, w * 0.5, h * 0.44, w * 0.8);
  const inner = [240, 238, 234];
  const outer = [217, 213, 207];
  // Many stops along a smooth curve: a three-stop gradient shows a visible ring at the middle stop.
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const k = smoothstep(0, 1, t) * 0.7 + t * t * 0.3;
    g.addColorStop(t, `rgb(${inner.map((c, j) => (c + (outer[j] - c) * k).toFixed(1)).join(',')})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const floor = ctx.createLinearGradient(0, h * 0.5, 0, h);
  floor.addColorStop(0, 'rgba(255,253,250,0)');
  floor.addColorStop(1, 'rgba(255,253,250,0.10)');
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, w, h);
}

function grain(ctx, w, h, amount, seed) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const rand = seeded(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() + rand() + rand() - 1.5) * amount * 2;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * A studio product photo. The object turns by `az` on the turntable (so
 * azimuth +90 shows its +x side), the camera looks from elevation `el`.
 */
function photo({ object, az = 0, el = 4, fov = 17, fill = 0.76, size = 1024, supersample = 2, quality = 0.9, crop = null, seed = 1, shadow = true }) {
  const o = show(object);
  studio.visible = true;
  o.root.rotation.y = -az * DEG;
  camera.fov = fov;
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  const framing = frame(o.root, el, fill);
  const shadowPlanes = [contactTight.plane, contactSoft.plane];
  contactTight.update(scene, shadowPlanes);
  contactSoft.update(scene, shadowPlanes);
  shadowPlanes.forEach((p) => (p.visible = shadow));

  const S = size * supersample;
  renderer.setSize(S, S, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  scene.environment = studioEnvironment;
  scene.environmentIntensity = 0.85;
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);

  const [full, fctx] = canvas2d(S, S);
  backdrop(fctx, S, S);
  fctx.drawImage(renderer.domElement, 0, 0);

  // Object bounds in pixels of the full render, for crops.
  const b = framing.bounds;
  const px = { left: ((b.minX + 1) / 2) * S, right: ((b.maxX + 1) / 2) * S, top: ((1 - b.maxY) / 2) * S, bottom: ((1 - b.minY) / 2) * S };
  let region = { x: 0, y: 0, w: S, h: S };
  let outW = size;
  let outH = size;
  if (crop) {
    const ow = px.right - px.left;
    const oh = px.bottom - px.top;
    const rh = Math.max(oh, ow / crop.aspect) * crop.margin;
    const rw = rh * crop.aspect;
    const cx = (px.left + px.right) / 2 + crop.dx * rw;
    const cy = (px.top + px.bottom) / 2 + crop.dy * rh;
    region = { x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh };
    outH = crop.height;
    outW = Math.round(crop.height * crop.aspect);
  }
  const [out, octx] = canvas2d(outW, outH);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(full, region.x, region.y, region.w, region.h, 0, 0, outW, outH);
  grain(octx, outW, outH, 1.1, seed);
  return {
    dataUrl: out.toDataURL('image/jpeg', quality),
    camera: { fovY: fov, elevationDeg: el, azimuthDeg: az, distance: framing.distance, target: framing.target },
  };
}

/** Plain turntable render matching docs/demo/groundtruth/cameras.json. */
function groundTruth({ object, az, el, fov, distance, target, size, supersample = 2, background }) {
  const o = show(object);
  studio.visible = false;
  o.root.rotation.y = 0;
  camera.fov = fov;
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  const t = new THREE.Vector3(...target);
  camera.up.set(0, 1, 0);
  camera.position.set(Math.cos(el * DEG) * Math.sin(az * DEG), Math.sin(el * DEG), Math.cos(el * DEG) * Math.cos(az * DEG)).multiplyScalar(distance).add(t);
  camera.lookAt(t);
  camera.updateMatrixWorld(true);

  const S = size * supersample;
  renderer.setSize(S, S, false);
  renderer.toneMapping = THREE.NoToneMapping;
  scene.environment = viewerEnvironment;
  scene.environmentIntensity = 1;
  scene.background = new THREE.Color(background);
  renderer.render(scene, camera);
  scene.background = null;
  const [out, octx] = canvas2d(size, size);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(renderer.domElement, 0, 0, size, size);
  return { dataUrl: out.toDataURL('image/png'), position: camera.position.toArray() };
}

function info(object) {
  return { box: getObject(object).box };
}

await Promise.all(
  [`700 64px ${SERIF}`, `italic 400 64px ${SERIF}`, `400 32px ${SANS}`, `500 32px ${SANS}`, `600 32px ${SANS}`, `700 32px ${SANS}`, `800 32px ${SANS}`]
    .map((f) => document.fonts.load(f).catch(() => null)),
);
window.trueformSamples = { photo, groundTruth, info };
window.samplesReady = true;
