// Renders the app icon (a wallet) into every PNG the web app and the Android app need.
// Run with `npm run icons` after changing the artwork. Uses Playwright's Chromium.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCENT = '#2a78d6';
const PAGE = '#f3f3ef';

// The wallet, drawn in a 64-unit box; its visible extent is about 36 units around (32, 33).
const WALLET = `
  <g fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">
    <path d="M14 22h31a5 5 0 0 1 5 5v19a5 5 0 0 1-5 5H19a5 5 0 0 1-5-5z"/>
    <path d="M14 24v-4a5 5 0 0 1 5-5h20v7"/>
    <path d="M50 31H40a5 5 0 0 0 0 10h10z" fill="${ACCENT}"/>
  </g>
  <circle cx="41" cy="36" r="2.5" fill="#fff"/>`;

/** shape: the background; glyph: the wallet's width as a share of the canvas. */
function iconSvg(size, { shape, glyph }) {
  const scale = (glyph * size) / 36;
  const background = {
    square: `<rect width="${size}" height="${size}" fill="${ACCENT}"/>`,
    rounded: `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="${ACCENT}"/>`,
    round: `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${ACCENT}"/>`,
    none: '',
  }[shape];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${background}
    <g transform="translate(${size / 2} ${size / 2}) scale(${scale}) translate(-32 -33)">${WALLET}</g>
  </svg>`;
}

function splashSvg(width, height) {
  const icon = Math.round(Math.min(width, height) * 0.3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${PAGE}"/>
    <g transform="translate(${(width - icon) / 2} ${(height - icon) / 2})">${iconSvg(icon, { shape: 'rounded', glyph: 0.6 })}</g>
  </svg>`;
}

const outputs = [
  ['public/icons/icon-192.png', iconSvg(192, { shape: 'square', glyph: 0.58 })],
  ['public/icons/icon-512.png', iconSvg(512, { shape: 'square', glyph: 0.58 })],
  // Maskable icons may be cropped to a circle of 80% of their size.
  ['public/icons/maskable-512.png', iconSvg(512, { shape: 'square', glyph: 0.46 })],
  ['public/icons/apple-touch-icon.png', iconSvg(180, { shape: 'square', glyph: 0.58 })],
];

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const res = 'android/app/src/main/res';
for (const [density, factor] of Object.entries(densities)) {
  outputs.push(
    [`${res}/mipmap-${density}/ic_launcher.png`, iconSvg(48 * factor, { shape: 'rounded', glyph: 0.56 })],
    [`${res}/mipmap-${density}/ic_launcher_round.png`, iconSvg(48 * factor, { shape: 'round', glyph: 0.52 })],
    // Adaptive icon foreground: 108dp, of which the launcher shows the middle 66dp or less.
    [`${res}/mipmap-${density}/ic_launcher_foreground.png`, iconSvg(108 * factor, { shape: 'none', glyph: 0.36 })],
  );
}
const splashes = {
  'drawable': [480, 320], 'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600], 'drawable-port-xxxhdpi': [1280, 1920],
  'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480], 'drawable-land-xhdpi': [1280, 720],
  'drawable-land-xxhdpi': [1600, 960], 'drawable-land-xxxhdpi': [1920, 1280],
};
for (const [folder, [width, height]] of Object.entries(splashes)) {
  outputs.push([`${res}/${folder}/splash.png`, splashSvg(width, height)]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, svg] of outputs) {
  const [, width, height] = /width="([\d.]+)" height="([\d.]+)"/.exec(svg).map(Number);
  await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  mkdirSync(dirname(join(root, file)), { recursive: true });
  await page.locator('svg').first().screenshot({ path: join(root, file), omitBackground: true });
  console.log(file);
}
await browser.close();
