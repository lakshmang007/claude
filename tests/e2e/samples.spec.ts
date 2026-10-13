import { expect, test } from '@playwright/test';
import { mockSamples, vasePhoto } from './fixtures';

test('a bundled sample brings its photo and reference views, and generating uses them', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const apiCalls: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/(search|image)/.test(r.url())) apiCalls.push(r.url());
  });
  await mockSamples(page);
  await page.goto('/?ai=0');

  await page.locator('#sample-buttons button', { hasText: 'Test vase' }).click();
  await expect(page.locator('#photo-info')).toContainText('test-vase.jpg');
  await expect(page.locator('#query')).toHaveValue('ceramic test vase');
  // Bundled images are presented as what they are: renders, not web photos.
  await expect(page.locator('#search-status')).toContainText('sample reference images (studio renders of a test object, bundled with the demo)');
  await expect(page.locator('#search-status')).toContainText('ranked by colour similarity');
  await expect(page.locator('#results .result')).toHaveCount(3);

  await page.click('#generate-btn');
  await expect(page.locator('#stats')).toContainText('watertight', { timeout: 90_000 });
  // The vase's two ends look alike, so its side view sets the depth but paints nothing.
  await expect(page.locator('#stats')).toContainText('reference views (sample): back · shape only: right');
  await expect(page.locator('.slot[data-view="back"]')).toHaveClass(/filled/);
  const right = page.locator('.slot[data-view="right"]');
  await expect(right).toHaveClass(/shape-only/);
  await expect(right.locator('.slot-badge')).toHaveAttribute('title', /not clear which end/);
  await expect(page.locator('.slot[data-view="left"]')).not.toHaveClass(/filled/);
  await expect(page.locator('#progress-log')).toContainText('Using sample images for: back, right (shape only)');

  // Whoever knows better can let it paint its texture too.
  await right.locator('.slot-badge').click();
  await expect(right).not.toHaveClass(/shape-only/);
  await expect(page.locator('#stats')).toContainText('reference views (sample): back, right ·', { timeout: 90_000 });
  // Sample files are the app's own: never searched for or fetched through the image proxy.
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});

test('auto-pick puts each side view in the slot of the end it shows', async ({ page }) => {
  await mockSamples(page);
  await page.goto('/?ai=0');
  await page.locator('#sample-buttons button', { hasText: 'Test toy' }).click();
  await expect(page.locator('#search-status')).toContainText('ranked by');
  await page.click('#autopick-btn');
  // The photo has the orange nose on its left and the blue tail on its right.
  await expect(page.locator('.slot[data-view="left"]')).toHaveAttribute('title', /test-toy\/nose\.png/);
  await expect(page.locator('.slot[data-view="right"]')).toHaveAttribute('title', /test-toy\/tail\.png/);
  await expect(page.locator('.slot.shape-only')).toHaveCount(0);
});

test('a reference slot takes an image address in an inline field', async ({ page }) => {
  await page.route('**/api/image**', (route) => route.fulfill({ body: vasePhoto(400, 400, 'back'), contentType: 'image/png' }));
  await page.goto('/?ai=0');
  const slot = page.locator('.slot[data-view="back"]');

  await slot.getByRole('button', { name: 'URL' }).click();
  const input = slot.locator('input.slot-url');
  await expect(input).toBeFocused();
  await input.fill('https://example.com/vase-back.png');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(slot).not.toHaveClass(/filled/);

  await slot.getByRole('button', { name: 'URL' }).click();
  await slot.locator('input.slot-url').fill('https://example.com/vase-back.png');
  await slot.locator('input.slot-url').press('Enter');
  await expect(slot).toHaveClass(/filled/);
  await expect(slot).toHaveAttribute('title', /example\.com\/vase-back\.png/);
});

test('reconstructs on the main thread when the worker cannot start', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.route('**/reconstruct.worker*', (route) => route.abort());
  await mockSamples(page);
  await page.goto('/?ai=0');
  await page.locator('#sample-buttons button').first().click();
  await expect(page.locator('#search-status')).toContainText('ranked by');
  await page.click('#generate-btn');
  await expect(page.locator('#stats')).toContainText('watertight', { timeout: 90_000 });
  expect(logs.some((l) => l.includes('running on the main thread'))).toBe(true);
});
