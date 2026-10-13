import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { expectToolbarClickable, vasePhoto } from './fixtures';

const dataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`;

async function mockSearch(page: Page, withResults: boolean) {
  const back = dataUrl(vasePhoto(400, 400, 'back'));
  const results = withResults
    ? [
        { id: 'mock:back', title: 'Vase, rear', thumbnail: back, url: back, source: 'Mock', hint: 'back' },
        { id: 'mock:front', title: 'Vase, front', thumbnail: dataUrl(vasePhoto(300, 300, 'front')), url: dataUrl(vasePhoto(300, 300, 'front')), source: 'Mock', hint: 'any' },
      ]
    : [];
  await page.route('**/api/search**', (route) =>
    route.fulfill({ json: { query: 'ceramic vase', results, errors: [], providers: [{ id: 'mock', label: 'Mock search' }] } }),
  );
}

async function upload(page: Page) {
  await page.setInputFiles('#file-input', { name: 'ceramic-vase.png', mimeType: 'image/png', buffer: vasePhoto() });
}

test('photo + web reference views -> watertight textured model and exports (classical pipeline)', async ({ page }) => {
  // Software WebGL plus four exports: close to the default timeout when the CPU is shared.
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockSearch(page, true);
  await page.goto('/?ai=0');
  await upload(page);
  await expect(page.locator('#photo-info')).toContainText('colour key');
  await expect(page.locator('#query')).toHaveValue('ceramic vase');

  await page.click('#generate-btn');
  await expect(page.locator('#stats')).toContainText('watertight', { timeout: 90_000 });
  await expect(page.locator('#stats')).toContainText('reference views: back');
  await expect(page.locator('.slot[data-view="back"]')).toHaveClass(/filled/);
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/01-model.png' });

  // Orbit to the side, then to the back.
  const canvas = page.locator('.viewer-canvas');
  const box = (await canvas.boundingBox())!;
  const orbit = async (dx: number) => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  await orbit(170);
  await page.screenshot({ path: 'test-results/02-side.png' });
  await orbit(250);
  await page.screenshot({ path: 'test-results/02-back.png' });

  await page.click('#compare-btn');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/03-compare.png' });
  await page.click('#compare-btn');

  const save = async (kind: string) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-export="${kind}"]`)]);
    return fs.readFile((await dl.path())!);
  };
  const glb = await save('glb');
  expect(glb.toString('ascii', 0, 4)).toBe('glTF');
  expect(glb.readUInt32LE(4)).toBe(2);
  const jsonLen = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
  expect(gltf.meshes).toHaveLength(1);
  expect(gltf.images?.[0]?.mimeType).toBe('image/jpeg');
  expect(gltf.materials[0].pbrMetallicRoughness.baseColorTexture).toBeTruthy();

  const stl = await save('stl');
  const tris = stl.readUInt32LE(80);
  expect(tris).toBeGreaterThan(1000);
  expect(stl.length).toBe(84 + tris * 50);

  const obj = await save('obj');
  expect(obj.toString('ascii', 0, 2)).toBe('PK');

  const usdz = await save('usdz');
  expect(usdz.toString('ascii', 0, 2)).toBe('PK');

  // Changing a setting regenerates in place.
  await page.locator('#settings summary').click();
  await page.locator('#settings-body select').first().selectOption('128');
  await expect(page.locator('#stats')).toContainText('watertight');
  expect(errors).toEqual([]);
});

test('falls back to the classical pipeline when AI models cannot be downloaded', async ({ page }) => {
  await page.route(/huggingface\.co|hf\.co|jsdelivr\.net/, (route) => route.abort());
  await mockSearch(page, false);
  await page.goto('/');
  await upload(page);
  await expect(page.locator('#photo-info')).toContainText('colour key', { timeout: 60_000 });
  await page.click('#generate-btn');
  await expect(page.locator('#stats')).toContainText('watertight', { timeout: 90_000 });
  await expect(page.locator('#stats')).toContainText('depth: silhouette');
  await expect(page.locator('#progress-log')).toContainText('No confident matches');
});

test('layout works on a phone-sized screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSearch(page, false);
  await page.goto('/?ai=0');
  await upload(page);
  await expect(page.locator('#photo-info')).toContainText('colour key');
  await page.click('#generate-btn');
  await expect(page.locator('#stats')).toContainText('watertight', { timeout: 90_000 });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectToolbarClickable(page);
    // Nothing covers the model: the toolbar and stats sit above the 3D view, the export bar below it.
    const view = (await page.locator('#viewer').boundingBox())!;
    expect((await page.locator('#stats').boundingBox())!.y + (await page.locator('#stats').boundingBox())!.height).toBeLessThanOrEqual(view.y + 1);
    expect((await page.locator('#exports').boundingBox())!.y).toBeGreaterThanOrEqual(view.y + view.height - 1);
    expect(view.height).toBeGreaterThan(300);
  }
  await page.screenshot({ path: 'test-results/04-mobile.png', fullPage: true });
});
