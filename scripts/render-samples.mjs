// Renders the demo samples with three.js in headless Chromium:
//   public/samples/<id>/*.jpg + public/samples/manifest.json   (studio "product photos" and web-search-like references)
//   docs/demo/groundtruth/<id>-az<deg>.png + cameras.json        (turntable views of the true object, for accuracy checks)
//
// Usage: node scripts/render-samples.mjs [sample-id ...]
// The scene itself lives in scripts/sample-scene.js. Output is deterministic for a given machine (fonts and GPU emulation).

import { createServer } from 'node:http';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samplesDir = path.join(root, 'public', 'samples');
const truthDir = path.join(root, 'docs', 'demo', 'groundtruth');

// Ground-truth camera convention (also written to cameras.json).
const TRUTH = {
  azimuthsDeg: [0, 45, 90, 135, 180],
  elevationDeg: 12,
  fovYDeg: 30,
  distance: 3,
  target: [0, 0.5, 0],
  size: 640,
  background: '#2a2f38',
};

const PHOTO_EL = 4;

const SAMPLES = [
  {
    id: 'hot-sauce',
    title: 'Hot sauce bottle',
    query: 'ember co smoked habanero hot sauce bottle',
    shots: {
      front: { az: 0, el: PHOTO_EL },
      back: { az: 180, el: PHOTO_EL },
      left: { az: -90, el: PHOTO_EL },
      right: { az: 90, el: PHOTO_EL },
      top: { az: 0, el: 90, fill: 0.62 },
      'three-quarter': { az: 45, el: 14, fill: 0.8 },
      'front-crop': { az: 0, el: PHOTO_EL, quality: 0.84, crop: { aspect: 0.8, margin: 1.12, dx: 0.03, dy: 0.01, height: 1000 } },
      distractor: { object: 'shampoo', az: 0, el: PHOTO_EL, fill: 0.74 },
    },
    references: [
      { shot: 'front-crop', title: 'Ember & Co. Smoked Habanero Hot Sauce 150 ml', hint: 'any' },
      { shot: 'three-quarter', title: 'Smoked Habanero hot sauce by Ember & Co.', hint: 'any' },
      { shot: 'back', title: 'Ember & Co. hot sauce, back label', hint: 'back' },
      { shot: 'distractor', title: 'Aqua Pure hydrating shampoo 300 ml', hint: 'any' },
      { shot: 'right', title: 'Ember & Co. Smoked Habanero, side view', hint: 'side' },
      { shot: 'left', title: 'Hot sauce bottle side view (Ember & Co.)', hint: 'side' },
      { shot: 'top', title: 'Ember & Co. hot sauce, top view', hint: 'top' },
    ],
  },
  {
    id: 'rubber-duck',
    title: 'Rubber duck',
    query: 'yellow rubber duck bath toy blue star',
    shots: {
      // The duck faces -x, so the photo (azimuth 0) is its left-side profile.
      front: { az: 0, el: PHOTO_EL },
      back: { az: 180, el: PHOTO_EL },
      left: { az: -90, el: PHOTO_EL },
      right: { az: 90, el: PHOTO_EL },
      top: { az: 0, el: 90, fill: 0.7 },
      'three-quarter': { az: -45, el: 14, fill: 0.78 },
      'front-crop': { az: 0, el: PHOTO_EL, quality: 0.84, crop: { aspect: 1.25, margin: 1.1, dx: -0.02, dy: 0.02, height: 820 } },
      distractor: { object: 'mug', az: 25, el: 13, fill: 0.7 },
    },
    references: [
      { shot: 'three-quarter', title: 'Classic yellow rubber duck with blue star', hint: 'any' },
      { shot: 'distractor', title: 'Green ceramic coffee mug', hint: 'any' },
      { shot: 'back', title: 'Rubber duck, other side (red heart)', hint: 'back' },
      { shot: 'front-crop', title: 'Yellow rubber duck bath toy', hint: 'any' },
      { shot: 'left', title: 'Rubber duck, head-on view', hint: 'side' },
      { shot: 'right', title: 'Rubber duck seen from behind', hint: 'side' },
      { shot: 'top', title: 'Rubber duck, top view', hint: 'top' },
    ],
  },
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
</head><body><script type="module" src="/scripts/sample-scene.js"></script></body></html>`;

function serve() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    const file = path.join(root, decodeURIComponent(url.pathname));
    const allowed = [path.join(root, 'node_modules', 'three') + path.sep, path.join(root, 'scripts') + path.sep];
    if (!allowed.some((dir) => file.startsWith(dir))) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function dataUrlBytes(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

function manifest() {
  return {
    samples: SAMPLES.map((s) => ({
      id: s.id,
      title: s.title,
      query: s.query,
      photo: `samples/${s.id}/front.jpg`,
      references: s.references.map((r) => ({
        id: `${s.id}-${r.shot}`,
        title: r.title,
        file: `samples/${s.id}/${r.shot}.jpg`,
        hint: r.hint,
        source: 'Sample render',
      })),
    })),
  };
}

async function main() {
  const only = process.argv.slice(2);
  const unknown = only.filter((id) => !SAMPLES.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown sample id(s): ${unknown.join(', ')}`);
  const samples = only.length ? SAMPLES.filter((s) => only.includes(s.id)) : SAMPLES;

  const server = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('requestfailed', (r) => errors.push(`failed to load ${r.url()}`));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`HTTP ${r.status()} for ${r.url()}`);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const deadline = Date.now() + 120_000;
    while (!errors.length && !(await page.evaluate(() => window.samplesReady === true))) {
      if (Date.now() > deadline) errors.push('timed out');
      await new Promise((r) => setTimeout(r, 200));
    }
    if (errors.length) throw new Error(`Sample scene failed to load:\n${errors.join('\n')}`);

    const truthObjects = {};
    for (const sample of samples) {
      const outDir = path.join(samplesDir, sample.id);
      await mkdir(outDir, { recursive: true });
      let photoCamera = null;
      for (const [name, shot] of Object.entries(sample.shots)) {
        const spec = { object: sample.id, seed: name.length * 97 + sample.id.length, ...shot };
        const t0 = Date.now();
        const result = await page.evaluate((s) => window.trueformSamples.photo(s), spec);
        const bytes = dataUrlBytes(result.dataUrl);
        await writeFile(path.join(outDir, `${name}.jpg`), bytes);
        if (name === 'front') photoCamera = result.camera;
        console.log(`${sample.id}/${name}.jpg  ${(bytes.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`);
      }

      await mkdir(truthDir, { recursive: true });
      const files = [];
      const positions = {};
      for (const az of TRUTH.azimuthsDeg) {
        const spec = { object: sample.id, az, el: TRUTH.elevationDeg, fov: TRUTH.fovYDeg, distance: TRUTH.distance, target: TRUTH.target, size: TRUTH.size, background: TRUTH.background };
        const result = await page.evaluate((s) => window.trueformSamples.groundTruth(s), spec);
        const file = `${sample.id}-az${az}.png`;
        await writeFile(path.join(truthDir, file), dataUrlBytes(result.dataUrl));
        files.push(file);
        positions[az] = result.position.map((v) => Number(v.toFixed(6)));
        console.log(`groundtruth/${file}`);
      }
      const { box } = await page.evaluate((id) => window.trueformSamples.info(id), sample.id);
      const round = (a) => a.map((v) => Number(v.toFixed(4)));
      truthObjects[sample.id] = {
        photo: `public/samples/${sample.id}/front.jpg`,
        files,
        boundingBox: { min: round(box.min), max: round(box.max) },
        photoCamera: photoCamera && {
          fovYDeg: photoCamera.fovY,
          elevationDeg: photoCamera.elevationDeg,
          azimuthDeg: photoCamera.azimuthDeg,
          distance: Number(photoCamera.distance.toFixed(4)),
          target: round(photoCamera.target),
        },
        cameraPositions: positions,
      };
    }

    await writeFile(path.join(samplesDir, 'manifest.json'), `${JSON.stringify(manifest(), null, 2)}\n`);
    await writeCameras(truthObjects);
  } finally {
    await browser.close();
    server.close();
  }

  const total = await dirSize(samplesDir);
  console.log(`public/samples: ${(total / 1024 / 1024).toFixed(2)} MB`);
  if (total > 4 * 1024 * 1024) console.warn('Warning: public/samples is larger than 4 MB');
}

async function writeCameras(objects) {
  const file = path.join(truthDir, 'cameras.json');
  // Keep entries for samples that were not re-rendered this run.
  let previous = {};
  try {
    previous = JSON.parse(await readFile(file, 'utf8')).objects ?? {};
  } catch {
    previous = {};
  }
  const doc = {
    description:
      'Ground-truth turntable renders of the demo samples (scripts/render-samples.mjs). Each object is the true 3D object the sample photos were rendered from.',
    coordinateSystem: {
      x: "right in the main photo (public/samples/<id>/front.jpg)",
      y: 'up',
      z: "towards the main photo's camera (the photo shows the object's +z side)",
      handedness: 'right-handed (three.js)',
      normalisation: 'object scaled to height 1.0, base on y = 0, bounding box centred on x = z = 0',
    },
    camera: {
      type: 'perspective',
      fovYDeg: TRUTH.fovYDeg,
      aspect: 1,
      near: 0.05,
      far: 100,
      target: TRUTH.target,
      distance: TRUTH.distance,
      elevationDeg: TRUTH.elevationDeg,
      up: [0, 1, 0],
      azimuthsDeg: TRUTH.azimuthsDeg,
      azimuth:
        "0 = the main photo's viewpoint (camera on +z). Positive azimuth moves the camera towards +x (the photo's right-hand side), i.e. counter-clockwise seen from above; 90 looks at the object's +x side, 180 at its back.",
      position: 'target + distance * [cos(el) * sin(az), sin(el), cos(el) * cos(az)]',
    },
    image: { width: TRUTH.size, height: TRUTH.size, format: 'png', background: TRUTH.background, file: '<id>-az<deg>.png' },
    rendering: {
      engine: 'three.js WebGLRenderer (headless Chromium, SwiftShader), 2x supersampled',
      lighting: 'RoomEnvironment through PMREMGenerator.fromScene(env, 0.04) as scene.environment only; no direct lights, no shadows',
      toneMapping: 'none',
      outputColorSpace: 'srgb',
    },
    objects: { ...previous, ...objects },
  };
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
