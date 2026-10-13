// Records the demo material in docs/demo/, as a visitor of the hosted demo sees it:
//   demo.mp4, demo.gif                 the real UI flow on the bundled samples (the GIF is the hot-sauce part)
//   01-sample-loaded.png … 04-compare.png, duck-model.png, duck-back.png, 05-phone.png (390x844)
//   comparison-<id>.png, comparison.json   reconstructions next to the ground-truth renders in docs/demo/groundtruth
//
// Usage: node scripts/record-demo.mjs   (npm run demo:record)
// Builds the hosted demo (npm run build:artifact; DEMO_SKIP_BUILD=1 reuses artifact/) and serves it with
// tests/e2e/artifact-host.mjs: wrapped in a host skeleton, under a sub-path, strict CSP, no /api. Every request
// outside that sub-path is blocked. AI stays off (?ai=0), so nothing needs network access.
// Needs public/samples and docs/demo/groundtruth (npm run samples:render), ffmpeg with libx264 and Python 3 with Pillow.

import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'demo');
const truthDir = path.join(outDir, 'groundtruth');

const PORT = 5191;
const ORIGIN = `http://127.0.0.1:${PORT}`;
// The sub-path tests/e2e/artifact-host.mjs serves artifact/ under.
const BASE_PATH = '/hosted/demo/';
const APP_URL = `${ORIGIN}${BASE_PATH}?ai=0`;
const VIEWPORT = { width: 1280, height: 800 };
// Tall enough to show the photo and the ranked references together in 01-sample-loaded.png.
const TALL_VIEWPORT = { width: 1280, height: 1160 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

// The viewer's resetView() direction (0.45, 0.2, 1): turntables start there so the camera does not jump.
const HOME_AZ = (Math.atan2(0.45, 1) * 180) / Math.PI;
const HOME_EL = (Math.asin(0.2 / Math.hypot(0.45, 0.2, 1)) * 180) / Math.PI;
const BACK_AZ = 160;
// The duck faces -x, so its tail end is at azimuth 90.
const TAIL_AZ = 90;

const VIDEO_FPS = 30;
const MP4_MAX_BYTES = 25e6;
const GIF_MAX_BYTES = 12e6;
// Waiting for a model is fast-forwarded to about this long in the video.
const GENERATE_SECONDS = 3.5;

// Playwright's recorder rounds every frame's duration, so the WebM drifts from the wall clock. Milestones are
// therefore shown as a colour in a square at the page's top-left corner, found again in the video and painted over.
const MARKS = ['start', 'hot-sauce:generate', 'hot-sauce:model', 'duck', 'rubber-duck:generate', 'rubber-duck:model', 'end'];
const MARK_COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
const MARKER_SIZE = 16;
// The top bar's background, which the marker covers.
const MARKER_COVER = '0x141922';

const log = (...a) => console.log('[demo]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Processes

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  if (res.error) throw new Error(`${cmd} could not start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} … failed (${res.status}):\n${res.stderr || res.stdout}`);
  return res.stdout;
}

/** Builds artifact/ and serves it like the locked-down artifact host. */
async function startHost() {
  if (process.env.DEMO_SKIP_BUILD) log('using the existing artifact/ (DEMO_SKIP_BUILD)');
  else {
    log('building the hosted demo (npm run build:artifact)');
    run('npm', ['run', 'build:artifact'], { cwd: root });
  }
  const proc = spawn(process.execPath, [path.join(root, 'tests', 'e2e', 'artifact-host.mjs'), String(PORT)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  let exited = false;
  proc.on('exit', () => (exited = true));
  const stop = () => {
    if (!exited) proc.kill('SIGTERM');
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`The artifact host exited before it was ready:\n${output}`);
    try {
      if ((await fetch(`${ORIGIN}${BASE_PATH}`)).ok) return stop;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  stop();
  throw new Error(`The artifact host did not start on ${ORIGIN}${BASE_PATH}:\n${output}`);
}

/** Like the hosted page: nothing outside the demo's own sub-path is reachable (no /api, no other origins). */
async function lockDown(context, errors) {
  await context.route(
    (url) => url.origin !== ORIGIN || !url.pathname.startsWith(BASE_PATH),
    (route) => {
      errors.push(`blocked request outside the demo: ${route.request().url()}`);
      return route.abort('blockedbyclient');
    },
  );
}

// ---------------------------------------------------------------------------
// In-page helpers for the recording: a visible cursor, captions and smooth camera, wipe and scroll moves.
// Runs before the app (addInitScript); only the recording context gets it.

function demoHelpers() {
  const CSS = `
    #demo-cursor { position: fixed; left: 0; top: 0; z-index: 10001; pointer-events: none; opacity: 0;
      transition: opacity .25s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); will-change: transform; }
    #demo-cursor.show { opacity: 1; }
    .demo-ripple { position: fixed; z-index: 10000; pointer-events: none; width: 44px; height: 44px; margin: -22px 0 0 -22px;
      border-radius: 50%; border: 2px solid #7dd3fc; animation: demo-ripple .45s ease-out forwards; }
    @keyframes demo-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1); opacity: 0; } }
    #demo-caption { position: fixed; bottom: 14px; z-index: 10000; pointer-events: none; max-width: 410px;
      padding: 8px 14px 8px 12px; border-radius: 8px; border: 1px solid #2a3240; border-left: 3px solid #7dd3fc;
      background: rgba(10,14,20,.9); color: #e6e9ef; font: 600 15px/1.35 Inter, ui-sans-serif, system-ui, sans-serif;
      opacity: 0; transform: translateY(6px); transition: opacity .3s, transform .3s; }
    #demo-caption.show { opacity: 1; transform: none; }
    #demo-marker { position: fixed; left: 0; top: 0; width: 16px; height: 16px; z-index: 10002; pointer-events: none; }
    html.demo-shot #demo-cursor, html.demo-shot #demo-caption, html.demo-shot .demo-ripple, html.demo-shot #demo-marker { display: none !important; }
  `;
  const ARROW =
    '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M4 2.5v19.2l5.1-4.9 3.3 7.4 3.4-1.5-3.3-7.3h7.1z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  let cursor = null;
  let caption = null;
  let marker = null;
  const pos = { x: 900, y: 430 };
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // Constant speed with soft starts and stops, for turntables.
  const ramp = (t, r = 0.15) => {
    const v = 1 / (1 - r);
    if (t < r) return (0.5 * v * t * t) / r;
    if (t > 1 - r) return 1 - (0.5 * v * (1 - t) * (1 - t)) / r;
    return 0.5 * v * r + v * (t - r);
  };
  async function tween(ms, fn) {
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      fn(t);
      if (t >= 1) return;
      await frame();
    }
  }
  function setup() {
    if (cursor) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = ARROW;
    caption = document.createElement('div');
    caption.id = 'demo-caption';
    marker = document.createElement('div');
    marker.id = 'demo-marker';
    document.body.append(cursor, caption, marker);
    place();
  }
  function place() {
    cursor.style.transform = `translate(${pos.x - 4}px, ${pos.y - 2}px)`;
  }
  function moveCursor(x, y) {
    pos.x = x;
    pos.y = y;
    place();
  }
  window.__demo = {
    mark(color) {
      setup();
      marker.style.background = color;
    },
    async cursorTo(x, y, ms = 650) {
      setup();
      cursor.classList.add('show');
      const from = { ...pos };
      await tween(ms, (t) => {
        const k = easeInOut(t);
        moveCursor(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      });
    },
    press() {
      setup();
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = `${pos.x}px`;
      r.style.top = `${pos.y}px`;
      document.body.append(r);
      setTimeout(() => r.remove(), 600);
    },
    hideCursor() {
      setup();
      cursor.classList.remove('show');
    },
    caption(text) {
      setup();
      if (!text) {
        caption.classList.remove('show');
        return;
      }
      const stage = document.getElementById('stage').getBoundingClientRect();
      caption.style.left = `${stage.left + 14}px`;
      caption.textContent = text;
      caption.classList.add('show');
    },
    async orbit(az0, az1, el0, el1, ms, linear = false) {
      const v = window.__trueform.viewer;
      await tween(ms, (t) => {
        const k = linear ? ramp(t) : easeInOut(t);
        v.setOrbit(az0 + (az1 - az0) * k, el0 + (el1 - el0) * k);
      });
    },
    /** Sweeps the compare wipe through `stops`, with the cursor riding on the slider's thumb. */
    async wipe(stops, msEach) {
      setup();
      const input = document.getElementById('split');
      const thumbAt = (value) => {
        const r = input.getBoundingClientRect();
        const thumb = 16;
        return { x: r.left + thumb / 2 + value * (r.width - thumb), y: r.top + r.height / 2 };
      };
      const set = (value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const p = thumbAt(value);
        moveCursor(p.x, p.y);
      };
      const start = thumbAt(Number(input.value));
      await this.cursorTo(start.x, start.y);
      for (let i = 1; i < stops.length; i++) {
        const a = stops[i - 1];
        const b = stops[i];
        await tween(msEach, (t) => set(a + (b - a) * easeInOut(t)));
      }
    },
    async scrollPanel(top, ms = 900) {
      const panel = document.getElementById('panel');
      const max = panel.scrollHeight - panel.clientHeight;
      let to = top;
      if (typeof top === 'string') {
        // A selector: bring that element to the top of the panel.
        const box = document.querySelector(top).getBoundingClientRect();
        to = panel.scrollTop + box.top - panel.getBoundingClientRect().top - 10;
      }
      to = Math.max(0, Math.min(max, to));
      const from = panel.scrollTop;
      await tween(ms, (t) => (panel.scrollTop = from + (to - from) * easeInOut(t)));
    },
  };
}

// ---------------------------------------------------------------------------
// Page actions

function watchErrors(page, errors) {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
}

/** Opens the hosted demo and waits until it has built its first sample, as it does for every visitor. */
async function openApp(page) {
  await page.goto(APP_URL);
  await page.evaluate(() => window.__trueform.ready);
  await waitModel(page, 0);
}

/** Waits until the given sample's references are ranked (the previous sample's text and scores do not count). */
async function waitRanked(page, id) {
  await page.waitForFunction(
    (id) => {
      const s = window.__trueform.state;
      return (
        s.sampleId === id &&
        !!s.rankMode &&
        s.candidates.length > 0 &&
        s.candidates.every((c) => c.result.id.startsWith(`${id}-`)) &&
        s.candidates.some((c) => c.score) &&
        /sample reference images .*ranked by/.test(document.getElementById('search-status').textContent)
      );
    },
    id,
    { timeout: 60_000 },
  );
}

const generation = (page) => page.evaluate(() => window.__trueform.state.generation);

async function waitModel(page, after) {
  await page.waitForFunction(
    (after) => {
      const s = window.__trueform.state;
      return s.generation > after && !s.busy && !!s.result && !!window.__trueform.viewer;
    },
    after,
    { timeout: 240_000 },
  );
}

/** Which sample file went into each reference slot, and which slots only shape the model. */
const slotSources = (page) =>
  page.evaluate(() => {
    const filled = [...document.querySelectorAll('.slot.filled')];
    return {
      picks: Object.fromEntries(filled.map((s) => [s.dataset.view, (s.getAttribute('title') || '').replace(/^From: /, '')])),
      shapeOnly: filled.filter((s) => s.classList.contains('shape-only')).map((s) => s.dataset.view),
    };
  });

const statsText = (page) => page.locator('#stats').innerText();

// ---------------------------------------------------------------------------
// A: the recorded walkthrough, B: screenshots taken along the way

async function recordWalkthrough(browser, tmp, errors) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, recordVideo: { dir: tmp, size: VIEWPORT } });
  await lockDown(context, errors);
  await context.addInitScript(demoHelpers);
  const page = await context.newPage();
  watchErrors(page, errors);
  const mark = (name) => page.evaluate((c) => window.__demo.mark(`rgb(${c})`), MARK_COLORS[MARKS.indexOf(name)].join(','));

  const pause = (ms) => page.waitForTimeout(ms);
  const say = (text) => page.evaluate((t) => window.__demo.caption(t), text);
  const scrollPanel = (top, ms) => page.evaluate(([top, ms]) => window.__demo.scrollPanel(top, ms), [top, ms]);
  const orbit = (az0, az1, el0, el1, ms, linear) => page.evaluate((a) => window.__demo.orbit(...a), [az0, az1, el0, el1, ms, linear]);
  const hideCursor = () => page.evaluate(() => window.__demo.hideCursor());
  const click = async (selector, after = 350) => {
    const target = page.locator(selector);
    const box = await target.boundingBox();
    if (!box) throw new Error(`${selector} is not visible`);
    await page.evaluate(([x, y]) => window.__demo.cursorTo(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
    await page.evaluate(() => window.__demo.press());
    await target.click();
    await pause(after);
  };
  const shot = async (name) => {
    await page.evaluate(() => document.documentElement.classList.add('demo-shot'));
    await page.screenshot({ path: path.join(outDir, name) });
    await page.evaluate(() => document.documentElement.classList.remove('demo-shot'));
    log('saved', name);
  };
  const generate = async (id) => {
    const before = await generation(page);
    await click('#generate-btn', 300);
    await mark(`${id}:generate`);
    // The auto-picked views land in the slots while the model is built.
    await scrollPanel('#slots', 1000);
    await waitModel(page, before);
    await mark(`${id}:model`);
    // The progress overlay fades out 0.6 s after the model is done.
    await pause(900);
  };
  const loadSample = async (id) => {
    await click(`#sample-buttons [data-sample="${id}"]`, 0);
    await waitRanked(page, id);
  };

  // Hot sauce: the hosted demo builds it by itself as the page opens, so the video starts with that.
  await page.goto(APP_URL);
  await mark('start');
  await say('The hosted demo opens on a bundled sample photo and builds the 3D model in your browser');
  await pause(1500);
  await mark('hot-sauce:generate');
  await page.evaluate(() => window.__trueform.ready);
  await waitModel(page, 0);
  await mark('hot-sauce:model');
  await pause(900);
  await say(null);
  await shot('02-model.png');
  await say('The front of the model is the photo itself');
  await pause(2400);
  await say('Reference images (bundled studio renders of the same bottle), ranked by similarity');
  await scrollPanel('#refs-card', 1100);
  await pause(2800);
  await say('Back and top images texture the model; the side image only sets its depth');
  await scrollPanel('#slots', 1000);
  await pause(3000);
  await say('Hidden sides are textured from the reference images');
  await orbit(HOME_AZ, HOME_AZ + 360, HOME_EL, HOME_EL, 8000, true);
  await say(null);
  await orbit(HOME_AZ + 360, BACK_AZ + 360, HOME_EL, HOME_EL, 1700);
  await pause(500);
  await shot('03-back.png');
  await say('The back label comes from the back reference image');
  await pause(2200);
  await say(null);
  await click('#compare-btn', 900);
  await shot('04-compare.png');
  await say('Compare with photo: wipe between render and photo');
  await page.evaluate(() => window.__demo.wipe([0.5, 0.06, 0.94, 0.5], 1700));
  await pause(1000);
  await say(null);
  await click('#compare-btn', 300);
  await click('[data-shading="clay"]', 200);
  await say('Clay shading shows the bare geometry');
  await orbit(BACK_AZ + 360, HOME_AZ + 360, HOME_EL, HOME_EL, 2800);
  await pause(1000);
  // The GIF ends with this part: no caption may outlive the view it describes.
  await say(null);
  await pause(400);
  await click('[data-shading="lit"]', 1300);
  await hideCursor();
  await pause(500);
  await mark('duck');

  // Rubber duck: picked by the visitor, then generated.
  await scrollPanel(0, 900);
  await say('A second sample: a rubber duck');
  await loadSample('rubber-duck');
  await pause(600);
  await say('Generate picks the back, both sides and the top from its reference images');
  await scrollPanel('#refs-card', 900);
  await pause(2000);
  await generate('rubber-duck');
  await say(null);
  await hideCursor();
  await shot('duck-model.png');
  await say('Each side image goes to the end it shows: the head-on view to the head, the rear view to the tail');
  await orbit(HOME_AZ, HOME_AZ + 360, HOME_EL, HOME_EL, 7000, true);
  await orbit(HOME_AZ + 360, TAIL_AZ + 360, HOME_EL, HOME_EL, 1400);
  await say('The tail end (90°), textured from the rear-view image');
  await pause(2600);
  await orbit(TAIL_AZ + 360, BACK_AZ + 360, HOME_EL, HOME_EL, 1200);
  await say('The heart on this side comes from the back reference image');
  await pause(400);
  await shot('duck-back.png');
  await pause(2000);
  await say(null);
  await click('#compare-btn', 600);
  await say('Compare with photo');
  await page.evaluate(() => window.__demo.wipe([0.5, 0.08, 0.92, 0.5], 1100));
  await pause(500);
  await say(null);
  await click('#compare-btn', 200);
  await click('[data-shading="clay"]', 200);
  await orbit(BACK_AZ + 360, HOME_AZ + 360, HOME_EL, HOME_EL, 1800);
  await pause(500);
  await click('[data-shading="lit"]', 300);
  await hideCursor();
  await pause(1800);
  await mark('end');
  // Under load the screencast runs seconds behind and closing drops what is still queued; a still page lets it catch up.
  await pause(5000);

  const video = page.video();
  await context.close();
  return video.path();
}

/** The hosted demo on a phone, as it opens. */
async function capturePhone(browser, errors) {
  const context = await browser.newContext({ viewport: PHONE_VIEWPORT, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await lockDown(context, errors);
  const page = await context.newPage();
  watchErrors(page, errors);
  await openApp(page);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, '05-phone.png') });
  log('saved 05-phone.png');
  await context.close();
}

// ---------------------------------------------------------------------------
// C: turntable captures for the comparison with the ground truth

/**
 * Renders the viewer's canvas only (no UI) with the ground-truth camera, scaled to the model's height. Uses the
 * Photo (unlit) shading: the texture already holds the photo's lighting, and the ground truth is lit by its
 * environment only, so extra viewer lights would make the colours differ for reasons unrelated to the model.
 */
async function captureViews(page, cam) {
  await page.click('[data-shading="unlit"]');
  const result = await page.evaluate((cam) => {
    const v = window.__trueform.viewer;
    const b = v.bounds();
    const height = b.max.y - b.min.y;
    v.setGridVisible(false);
    v.setBackground(cam.background);
    v.setFov(cam.fovYDeg);
    v.setOrbitTarget({ x: b.center.x, y: b.center.y, z: b.center.z });
    // Supersample like the ground truth (rendered at 2x).
    const ratio = v.renderer.getPixelRatio();
    v.renderer.setPixelRatio(2);
    const shots = {};
    for (const az of cam.azimuthsDeg) {
      v.setOrbit(az, cam.elevationDeg, cam.distance * height);
      shots[az] = v.screenshot();
    }
    v.renderer.setPixelRatio(ratio);
    v.setOrbitTarget(null);
    v.setBackground(null);
    v.setGridVisible(true);
    v.setFov(35);
    v.resetView();
    const size = { x: b.max.x - b.min.x, y: height, z: b.max.z - b.min.z };
    return { shots, size };
  }, cam);
  await page.click('[data-shading="lit"]');
  return result;
}

async function saveShots(shots, dir, prefix) {
  const files = {};
  for (const [az, url] of Object.entries(shots)) {
    const file = path.join(dir, `${prefix}-az${az}.png`);
    await writeFile(file, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    files[az] = file;
  }
  return files;
}

async function captureComparisons(browser, tmp, cameras, samples, errors) {
  const context = await browser.newContext({ viewport: TALL_VIEWPORT, deviceScaleFactor: 1 });
  await lockDown(context, errors);
  const page = await context.newPage();
  watchErrors(page, errors);
  // What a visitor sees once the demo has opened, with the photo and the ranked reference images in view.
  await openApp(page);
  await page.evaluate(() => (document.getElementById('panel').scrollTop = 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, '01-sample-loaded.png') });
  log('saved 01-sample-loaded.png');
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(400);

  const cam = { ...cameras.camera, background: cameras.image.background };
  const out = [];
  for (const sample of samples) {
    const { id } = sample;
    log(`comparison: ${id}`);
    await page.locator(`#sample-buttons [data-sample="${id}"]`).click();
    await waitRanked(page, id);
    const ranking = await page.evaluate(() =>
      window.__trueform.state.candidates
        .filter((c) => c.score)
        .map((c) => ({ file: c.result.url, view: c.score.view, similarity: Math.round(c.score.similarity * 1000) / 1000 })),
    );

    // 1) The normal flow: Generate auto-picks the reference views.
    let before = await generation(page);
    await page.click('#generate-btn');
    await waitModel(page, before);
    const withRefs = { stats: await statsText(page), ...(await slotSources(page)) };
    const refsCapture = await captureViews(page, cam);
    withRefs.files = await saveShots(refsCapture.shots, tmp, `${id}-refs`);
    withRefs.size = refsCapture.size;

    // 2) Photo only: no reference views and no automatic search.
    for (const view of Object.keys(withRefs.picks)) await page.locator(`.slot[data-view="${view}"] button[title="Remove"]`).click();
    // Removing a view rebuilds the model by itself; Generate is ignored while that runs.
    const idleWithoutViews = () => {
      const stats = document.getElementById('stats').textContent;
      return !window.__trueform.state.busy && /reference views: none/.test(stats) && !/shape only/.test(stats);
    };
    await page.waitForFunction(idleWithoutViews, null, { timeout: 120_000 });
    // A removal made during a rebuild queues one more after a 0.4 s debounce.
    await page.waitForTimeout(700);
    await page.waitForFunction(idleWithoutViews, null, { timeout: 120_000 });
    await page.locator('#auto-refs').uncheck();
    before = await generation(page);
    await page.click('#generate-btn');
    await waitModel(page, before);
    const photoOnly = { stats: await statsText(page), ...(await slotSources(page)) };
    const photoCapture = await captureViews(page, cam);
    photoOnly.files = await saveShots(photoCapture.shots, tmp, `${id}-photo`);
    photoOnly.size = photoCapture.size;
    await page.locator('#auto-refs').check();

    out.push({ id, title: sample.title, ranking, withRefs, photoOnly });
  }
  await context.close();
  return out;
}

// ---------------------------------------------------------------------------
// Video encoding

/** Video times of the milestones, from the colour of the marker square in each frame. */
function findMarks(webm) {
  const rate = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', webm]).trim();
  const [num, den] = rate.split('/').map(Number);
  const fps = num / (den || 1);
  const inset = MARKER_SIZE / 4;
  const res = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-i', webm, '-vf', `crop=${MARKER_SIZE / 2}:${MARKER_SIZE / 2}:${inset}:${inset},scale=1:1:flags=area`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { maxBuffer: 1 << 28 },
  );
  if (res.status !== 0) throw new Error(`Could not read the markers: ${res.stderr}`);
  const px = res.stdout;
  const frames = px.length / 3;
  const colorAt = (f) => {
    let best = -1;
    let bestD = 100 * 100;
    MARK_COLORS.forEach((c, k) => {
      const d = (px[f * 3] - c[0]) ** 2 + (px[f * 3 + 1] - c[1]) ** 2 + (px[f * 3 + 2] - c[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  };
  const times = {};
  let f = 0;
  MARKS.forEach((name, k) => {
    while (f < frames && colorAt(f) !== k) f++;
    if (f < frames) times[name] = f / fps;
    else if (name === 'end') {
      log('warning: the recording stops before the end marker; its last seconds are missing');
      times.end = frames / fps;
    } else throw new Error(`The ${name} marker is not in the video`);
  });
  return { times, duration: frames / fps };
}

/** Speeds up the waits for a model and trims the blank start; returns the segments and a time mapping. */
function planCuts(marks, duration, ids) {
  const at = (name) => Math.min(duration, marks[name]);
  const cuts = [];
  let t = at('start');
  for (const id of ids) {
    const a = at(`${id}:generate`) + 0.7;
    const b = at(`${id}:model`) - 0.3;
    const speed = (b - a) / GENERATE_SECONDS;
    if (speed <= 1.2) continue;
    cuts.push({ start: t, end: a, speed: 1 }, { start: a, end: b, speed });
    t = b;
  }
  cuts.push({ start: t, end: Math.min(duration, at('end') + 0.3), speed: 1 });
  const map = (time) => {
    let out = 0;
    for (const c of cuts) {
      if (time <= c.start) break;
      out += (Math.min(time, c.end) - c.start) / c.speed;
    }
    return out;
  };
  return { cuts, map };
}

function encodeMp4(webm, cuts, file) {
  const n = cuts.length;
  const parts = cuts.map((c, i) => `[s${i}]trim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},setpts=(PTS-STARTPTS)/${c.speed.toFixed(4)}[v${i}]`);
  const filter = [
    `[0:v]split=${n}${cuts.map((_, i) => `[s${i}]`).join('')}`,
    ...parts,
    `${cuts.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0,drawbox=x=0:y=0:w=${MARKER_SIZE}:h=${MARKER_SIZE}:color=${MARKER_COVER}@1:t=fill,fps=${VIDEO_FPS},scale=1280:-2:flags=lanczos,format=yuv420p[out]`,
  ].join(';');
  let size = Infinity;
  for (const crf of [20, 24, 28]) {
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(VIDEO_FPS), '-movflags', '+faststart', '-an', file]);
    size = statSync(file).size;
    if (size <= MP4_MAX_BYTES) return;
  }
  throw new Error(`${file} is ${(size / 1e6).toFixed(1)} MB even at CRF 28`);
}

function encodeGif(mp4, seconds, file) {
  let size = Infinity;
  for (const [fps, colors] of [[12, 256], [12, 128], [10, 128], [8, 96]]) {
    const filter = `fps=${fps},scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    run('ffmpeg', ['-y', '-loglevel', 'error', '-t', seconds.toFixed(3), '-i', mp4, '-filter_complex', filter, '-loop', '0', file]);
    size = statSync(file).size;
    if (size <= GIF_MAX_BYTES) return { fps, colors };
  }
  throw new Error(`${file} is ${(size / 1e6).toFixed(1)} MB even at 8 fps`);
}

// ---------------------------------------------------------------------------
// Comparison grids (Python + Pillow)

// Eight azimuths as two blocks side by side (0-135 left, 180-315 right), so each row shows opposite sides and
// the three columns of one azimuth stay next to each other.
const COMPOSE_PY = String.raw`
import json, os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

job = json.load(open(sys.argv[1]))
BG = tuple(int(job['background'][i:i + 2], 16) for i in (1, 3, 5))
SHEET = (17, 21, 28)
TEXT, MUTED, RULE = (230, 233, 239), (154, 164, 181), (44, 52, 66)
CELL, GAP, LABEL_W, BLOCK_GAP = 320, 8, 84, 34
TRUTH_SIZE = 640
FONTS = {}

def font(size, bold=False):
    key = (size, bold)
    if key not in FONTS:
        names = ['Inter-SemiBold.otf' if bold else 'Inter-Regular.otf', 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf',
                 'LiberationSans-Bold.ttf' if bold else 'LiberationSans-Regular.ttf']
        found = None
        for n in names:
            for d, _, files in os.walk('/usr/share/fonts'):
                if n in files:
                    found = os.path.join(d, n)
                    break
            if found:
                break
        FONTS[key] = ImageFont.truetype(found, size) if found else ImageFont.load_default(size)
    return FONTS[key]

def square(path, resample=Image.LANCZOS):
    # The viewer canvas is wider than tall with a vertical FOV, so its centred square matches the square ground-truth camera.
    im = Image.open(path).convert('RGB')
    w, h = im.size
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    return im.resize((TRUTH_SIZE, TRUTH_SIZE), resample)

def mask(im):
    # Both renders have an exactly uniform background; dark parts of the objects are only a few levels away from it.
    r, g, b = ImageChops.difference(im, Image.new('RGB', im.size, BG)).split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v > 2 else 0).convert('1')

def count(m):
    return m.histogram()[-1]

def iou(a, b):
    ma, mb = mask(a), mask(b)
    union = count(ImageChops.logical_or(ma, mb))
    return count(ImageChops.logical_and(ma, mb)) / union if union else 0.0

def fitted(d, text, width, size, bold=True):
    while size > 11 and d.textlength(text, font=font(size, bold)) > width:
        size -= 1
    return font(size, bold)

metrics = {}
for s in job['samples']:
    azs = s['azimuths']
    rows = (len(azs) + 1) // 2
    blocks = [azs[:rows], azs[rows:]]
    cols = [('Original object', s['truth']), ('TrueForm: photo + reference images', s['refs']), ('TrueForm: photo only', s['photo'])]
    truth = {az: Image.open(s['truth'][str(az)]).convert('RGB').resize((TRUTH_SIZE, TRUTH_SIZE), Image.LANCZOS) for az in azs}
    m = {'refs': {}, 'photo': {}}
    for key in m:
        for az in azs:
            # Area-averaged like the supersampled ground truth, so both outlines are anti-aliased alike.
            m[key][az] = round(iou(truth[az], square(s[key][str(az)], Image.BOX)), 3)
    mean = {key: round(sum(v.values()) / len(v), 3) for key, v in m.items()}
    # Every cell shows the same square crop around all the outlines, so the objects are larger but still comparable.
    box = None
    for az in azs:
        for im in (truth[az], square(s['refs'][str(az)]), square(s['photo'][str(az)])):
            b = mask(im).getbbox()
            if b:
                box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    side = min(TRUTH_SIZE, int(max(box[2] - box[0], box[3] - box[1]) * 1.12) + 8)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    left = int(min(max(cx - side / 2, 0), TRUTH_SIZE - side))
    top_ = int(min(max(cy - side / 2, 0), TRUTH_SIZE - side))
    crop = (left, top_, left + side, top_ + side)

    block_w = LABEL_W + 3 * (CELL + GAP)
    W = GAP + 2 * block_w + BLOCK_GAP
    lines = s['subtitle'] + [f"Mean silhouette IoU over the {len(azs)} views: {mean['refs']:.3f} with reference images, {mean['photo']:.3f} from the photo only."]
    top = 70 + 24 * len(lines) + 10
    H = top + 44 + rows * (CELL + GAP) + GAP
    sheet = Image.new('RGB', (W, H), SHEET)
    d = ImageDraw.Draw(sheet)
    d.text((GAP + 6, 20), s['title'] + ': ground truth vs. reconstruction', font=font(30, True), fill=TEXT)
    for i, line in enumerate(lines):
        d.text((GAP + 6, 70 + 24 * i), line, font=font(17), fill=MUTED)
    head_f = min((fitted(d, name, CELL - 6, 19) for name, _ in cols), key=lambda f: f.size)
    for b, block in enumerate(blocks):
        x0 = GAP + b * (block_w + BLOCK_GAP)
        if b:
            d.line((x0 - BLOCK_GAP / 2, top + 6, x0 - BLOCK_GAP / 2, H - GAP), fill=RULE, width=2)
        for c, (name, _) in enumerate(cols):
            x = x0 + LABEL_W + c * (CELL + GAP)
            d.text((x + CELL / 2, top + 22), name, font=head_f, fill=TEXT, anchor='mm')
        for r, az in enumerate(block):
            y = top + 44 + r * (CELL + GAP)
            d.text((x0 + LABEL_W / 2, y + CELL / 2 - 12), f'{az}°', font=font(26, True), fill=TEXT, anchor='mm')
            d.text((x0 + LABEL_W / 2, y + CELL / 2 + 18), 'azimuth', font=font(15), fill=MUTED, anchor='mm')
            for c, (name, files) in enumerate(cols):
                im = truth[az] if c == 0 else square(files[str(az)])
                x = x0 + LABEL_W + c * (CELL + GAP)
                sheet.paste(im.crop(crop).resize((CELL, CELL), Image.LANCZOS), (x, y))
                if c:
                    value = m['refs' if c == 1 else 'photo'][az]
                    label = f'silhouette IoU {value:.2f}'
                    small = font(15)
                    tw = d.textlength(label, font=small)
                    d.rounded_rectangle((x + 8, y + CELL - 34, x + 24 + tw, y + CELL - 8), 6, fill=(10, 14, 20))
                    d.text((x + 16, y + CELL - 21), label, font=small, fill=(200, 208, 220), anchor='lm')
    sheet.save(s['out'], optimize=True)
    metrics[s['id']] = {'refs': m['refs'], 'photo': m['photo'], 'mean': mean}
json.dump(metrics, sys.stdout)
`;

function composeGrids(results, cameras, tmp) {
  const cam = cameras.camera;
  const views = (r) => {
    const texture = Object.keys(r.withRefs.picks).filter((v) => !r.withRefs.shapeOnly.includes(v));
    const shape = r.withRefs.shapeOnly.length ? `; shape only (depth, no texture): ${r.withRefs.shapeOnly.join(', ')}` : '';
    return `Reference images auto-picked from the bundled samples: ${texture.join(', ') || 'none'} for texture${shape}.`;
  };
  const job = {
    background: cameras.image.background,
    samples: results.map((r) => ({
      id: r.id,
      title: r.title,
      subtitle: [
        `Same camera in every column (${cam.fovYDeg}° FOV, ${cam.elevationDeg}° elevation, distance ${cam.distance}× the object height), every cell cropped alike. Hosted demo build, classical pipeline (AI off).`,
        `Reconstructions captured in the viewer's Photo (unlit) shading, for a like-with-like comparison with the environment-lit original.`,
        views(r),
      ],
      azimuths: cam.azimuthsDeg,
      truth: Object.fromEntries(cam.azimuthsDeg.map((az) => [String(az), path.join(truthDir, `${r.id}-az${az}.png`)])),
      refs: r.withRefs.files,
      photo: r.photoOnly.files,
      out: path.join(outDir, `comparison-${r.id}.png`),
    })),
  };
  const jobFile = path.join(tmp, 'compose.json');
  return writeFile(jobFile, JSON.stringify(job)).then(() => JSON.parse(run('python3', ['-c', COMPOSE_PY, jobFile])));
}

// ---------------------------------------------------------------------------

async function main() {
  const manifest = JSON.parse(await readFile(path.join(root, 'public', 'samples', 'manifest.json'), 'utf8').catch(() => 'null'));
  const cameras = JSON.parse(await readFile(path.join(truthDir, 'cameras.json'), 'utf8').catch(() => 'null'));
  if (!manifest?.samples?.length || !cameras) throw new Error('Samples or ground truth missing: run npm run samples:render first.');
  const samples = manifest.samples.filter((s) => cameras.objects?.[s.id]);
  if (!samples.find((s) => s.id === 'hot-sauce') || !samples.find((s) => s.id === 'rubber-duck')) {
    throw new Error('The walkthrough needs the hot-sauce and rubber-duck samples.');
  }
  run('ffmpeg', ['-hide_banner', '-version']);
  run('python3', ['-c', 'import PIL']);

  await mkdir(outDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'trueform-demo-'));
  const stopHost = await startHost();
  const errors = [];
  let browser;
  try {
    browser = await chromium.launch({ args: GL_ARGS });
    log('recording the walkthrough');
    const webm = await recordWalkthrough(browser, tmp, errors);
    log('capturing the phone screenshot');
    await capturePhone(browser, errors);
    log('capturing the ground-truth comparison');
    const results = await captureComparisons(browser, tmp, cameras, samples, errors);
    await browser.close();
    browser = null;
    stopHost();

    log('encoding video');
    const { times, duration } = findMarks(webm);
    const { cuts, map } = planCuts(times, duration, ['hot-sauce', 'rubber-duck']);
    const mp4 = path.join(outDir, 'demo.mp4');
    encodeMp4(webm, cuts, mp4);
    const gif = encodeGif(mp4, map(times.duck), path.join(outDir, 'demo.gif'));

    log('composing comparison grids');
    const metrics = await composeGrids(results, cameras, tmp);
    const report = {
      generated: new Date().toISOString(),
      recordedWith:
        'Hosted demo build (npm run build:artifact) served by tests/e2e/artifact-host.mjs (host skeleton, sub-path, strict CSP, no /api); classical pipeline (AI off, ?ai=0); reference images auto-picked from the bundled samples.',
      note: "Silhouette IoU against the ground-truth renders, per azimuth (1 = identical outline). Models are scaled to the ground truth's height and rendered with its camera in the viewer's Photo (unlit) shading.",
      azimuthsDeg: cameras.camera.azimuthsDeg,
      samples: results.map((r) => ({
        id: r.id,
        ranking: r.ranking,
        truthSize: (({ min, max }) => ({ x: +(max[0] - min[0]).toFixed(3), y: 1, z: +(max[2] - min[2]).toFixed(3) }))(cameras.objects[r.id].boundingBox),
        withRefs: {
          stats: r.withRefs.stats,
          picks: r.withRefs.picks,
          shapeOnly: r.withRefs.shapeOnly,
          size: normSize(r.withRefs.size),
          iou: metrics[r.id].refs,
          meanIou: metrics[r.id].mean.refs,
        },
        photoOnly: {
          stats: r.photoOnly.stats,
          picks: r.photoOnly.picks,
          size: normSize(r.photoOnly.size),
          iou: metrics[r.id].photo,
          meanIou: metrics[r.id].mean.photo,
        },
      })),
    };
    await writeFile(path.join(outDir, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);

    const files = ['demo.mp4', 'demo.gif', '01-sample-loaded.png', '02-model.png', '03-back.png', '04-compare.png', '05-phone.png', 'duck-model.png', 'duck-back.png', ...results.map((r) => `comparison-${r.id}.png`), 'comparison.json'];
    console.log('\nFiles:');
    for (const f of files) console.log(`  docs/demo/${f.padEnd(26)} ${((await stat(path.join(outDir, f))).size / 1e6).toFixed(2)} MB`);
    console.log(`\nVideo: ${map(duration).toFixed(1)} s from ${duration.toFixed(1)} s recorded (GIF: first ${map(times.duck).toFixed(1)} s at ${gif.fps} fps, ${gif.colors} colours)`);
    for (const s of report.samples) {
      console.log(`\n${s.id}`);
      console.log(`  auto-picked: ${Object.entries(s.withRefs.picks).map(([k, v]) => `${k} <- ${v}${s.withRefs.shapeOnly.includes(k) ? ' (shape only)' : ''}`).join(', ') || 'none'}`);
      console.log(`  with refs:   ${s.withRefs.stats}`);
      console.log(`  photo only:  ${s.photoOnly.stats}`);
      console.log(`  size (w x h x d, height 1): truth ${s.truthSize.x} x 1 x ${s.truthSize.z}, refs ${s.withRefs.size.x} x 1 x ${s.withRefs.size.z}, photo only ${s.photoOnly.size.x} x 1 x ${s.photoOnly.size.z}`);
      console.log(`  silhouette IoU by azimuth: refs ${JSON.stringify(s.withRefs.iou)} (mean ${s.withRefs.meanIou}), photo only ${JSON.stringify(s.photoOnly.iou)} (mean ${s.photoOnly.meanIou})`);
    }
    if (errors.length) console.log(`\nPage errors:\n  ${errors.join('\n  ')}`);
  } finally {
    await browser?.close();
    stopHost();
    // DEMO_KEEP_TMP=1 keeps the raw WebM and the canvas captures for debugging.
    if (process.env.DEMO_KEEP_TMP) log('kept', tmp);
    else await rm(tmp, { recursive: true, force: true });
  }
}

const normSize = (s) => ({ x: +(s.x / s.y).toFixed(3), y: 1, z: +(s.z / s.y).toFixed(3) });

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
