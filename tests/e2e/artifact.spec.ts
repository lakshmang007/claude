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
