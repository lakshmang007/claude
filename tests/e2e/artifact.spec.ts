import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectToolbarClickable, mockSamples } from './fixtures';

// Served by tests/e2e/artifact-host.mjs (see playwright.config.ts), which builds artifact/ first.
const HOSTED = 'http://127.0.0.1:5180/hosted/demo/';
const artifact = (rel: string) => fileURLToPath(new URL(`../../artifact/${rel}`, import.meta.url));

test('the artifact page has no skeleton of its own, inlines its CSS and loads assets relatively', () => {
  const html = fs.readFileSync(artifact('index.html'), 'utf8');
  expect(html.startsWith('<title>TrueForm 3D</title>')).toBe(true);
  expect(html).not.toMatch(/<!doctype|<html[\s>]|<\/html>|<head[\s>]|<\/head>|<body[\s>]|<\/body>/i);
  expect(html).not.toMatch(/<link\b/i);
  expect(html).toMatch(/<style>[\s\S]+<\/style>/);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  expect(scripts).toHaveLength(1);
  const src = scripts[0].match(/^<script type="module" src="(assets\/[\w.-]+\.js)">$/)?.[1];
  expect(src, scripts[0]).toBeTruthy();
  expect(fs.existsSync(artifact(src!))).toBe(true);
  expect(html).not.toMatch(/\b(?:src|href)\s*=\s*"\/(?!\/)/);
  expect(fs.readdirSync(artifact('assets')).filter((f) => f.endsWith('.wasm'))).toEqual([]);
});

test('the hosted demo opens with a finished model built from the bundled sample', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) => console.error(`Refused to load ${e.blockedURI} (${e.violatedDirective})`)),
  );
  const apiCalls: string[] = [];
  page.on('request', (r) => {
    if (/\/api\//.test(new URL(r.url()).pathname)) apiCalls.push(r.url());
  });
  await mockSamples(page);
  await page.goto(HOSTED);

  await expect(page).toHaveTitle('TrueForm 3D');
  await expect(page.locator('#stats')).toContainText('watertight', { timeout: 90_000 });
  await expect(page.locator('#stats')).toContainText('reference views (sample): back');
  await expect(page.locator('#sample-buttons button.active')).toHaveText('Test vase');
  await expect(page.locator('#samples-note')).toContainText('3D renders of test objects, not real photos');
  await expect(page.locator('#ai-badge')).toHaveText('AI: off');
  await expect(page.locator('#search-badge')).toHaveText('Web search: samples');
  await expect(page.locator('#search-badge')).toHaveAttribute('title', /npm start/);
  await expect(page.locator('#search-status')).toContainText('npm start');
  await expect(page.locator('#export-note')).toBeVisible();

  // The models cannot be downloaded here, so the AI option is off and says why.
  await page.locator('#settings summary').click();
  await expect(page.locator('#settings-body input[type="checkbox"]').last()).toBeDisabled();
  await expect(page.locator('#ai-note')).toHaveText('Not available in the hosted demo — run TrueForm locally.');

  // No search server behind a static host: the demo explains that instead of searching.
  await page.click('#search-btn');
  await expect(page.locator('#search-status')).toHaveText(/^Live web search needs the TrueForm server \(npm start\)/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/05-hosted-demo.png' });

  // On a phone the toolbar stays clickable.
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await expectToolbarClickable(page);
  }
  // Not even a health probe: the host's own /api (outside the demo's sub-path) is never called.
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});

type Hook = { __trueform: { state: { generation: number; busy: boolean; result: unknown } } };

test('the hosted demo builds a sample as soon as it is picked, downloading each of its images once', async ({ page }) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The host sends no cache headers, so an image shown again would be downloaded again.
  const downloads = new Map<string, number>();
  page.on('request', (r) => {
    const file = new URL(r.url()).pathname;
    if (/\/samples\/.+\.(jpe?g|png|webp)$/.test(file)) downloads.set(file, (downloads.get(file) ?? 0) + 1);
  });
  await page.goto(HOSTED);
  const stats = page.locator('#stats');
  await expect(stats).toContainText('watertight', { timeout: 90_000 });
  await expect(page.locator('#sample-buttons button.active')).toHaveText('Hot sauce bottle');
  // The bottle looks the same from either side, so both side images texture it, each the way round its side is seen.
  await expect(stats).toContainText('reference views (sample): back, left, right, top ·');
  await expect(page.locator('.slot[data-view="left"]')).toHaveAttribute('title', /hot-sauce\/left\.jpg/);
  await expect(page.locator('.slot[data-view="right"]')).toHaveAttribute('title', /hot-sauce\/right\.jpg/);
  await expect(page.locator('.slot.mirrored, .slot.shape-only')).toHaveCount(0);

  const before = await page.evaluate(() => (window as unknown as Hook).__trueform.state.generation);
  await page.locator('#sample-buttons [data-sample="rubber-duck"]').click();
  // The bottle stays in view, dimmed, until the duck is built; it cannot be exported or compared meanwhile.
  await expect(page.locator('#stale-note')).toBeVisible();
  await expect(page.locator('[data-export="glb"]')).toBeDisabled();
  await expect(page.locator('#compare-btn')).toBeDisabled();
  await page.waitForFunction(
    (before) => {
      const s = (window as unknown as Hook).__trueform.state;
      return s.generation > before && !s.busy && !!s.result;
    },
    before,
    { timeout: 90_000 },
  );
  await expect(page.locator('#stale-note')).toBeHidden();
  await expect(page.locator('[data-export="glb"]')).toBeEnabled();
  // Each side image goes to the end it shows: the head-on view to the head (left), the rear view to the tail.
  await expect(stats).toContainText('reference views (sample): back, left, right, top ·');
  await expect(page.locator('.slot[data-view="left"]')).toHaveAttribute('title', /rubber-duck\/left\.jpg/);
  await expect(page.locator('.slot[data-view="right"]')).toHaveAttribute('title', /rubber-duck\/right\.jpg/);
  await expect(page.locator('.slot.mirrored, .slot.shape-only')).toHaveCount(0);

  // Both photos and all 14 reference images, each downloaded once (twice at most), however often the lists re-render.
  expect(downloads.size).toBe(16);
  expect([...downloads].filter(([, n]) => n > 2)).toEqual([]);
  expect(errors).toEqual([]);
});
