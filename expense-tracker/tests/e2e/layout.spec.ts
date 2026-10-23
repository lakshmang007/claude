import { expect, test, type Page } from '@playwright/test';

// Every screen, and the sheet it opens, must fit the phone's width.
const screens: { name: string; open: (page: Page) => Promise<void>; sheet: string }[] = [
  { name: 'Home', open: (page) => page.getByRole('navigation').getByRole('button', { name: 'Home' }).click(), sheet: 'Add transaction' },
  { name: 'History', open: (page) => page.getByRole('navigation').getByRole('button', { name: 'History' }).click(), sheet: 'Add transaction' },
  { name: 'Tracker', open: (page) => page.getByRole('navigation').getByRole('button', { name: 'Tracker' }).click(), sheet: 'Add transaction' },
  { name: 'People', open: (page) => page.getByRole('navigation').getByRole('button', { name: 'People' }).click(), sheet: 'They owe me' },
  { name: 'Savings', open: (page) => page.getByRole('navigation').getByRole('button', { name: 'Savings' }).click(), sheet: 'Skip a craving' },
  { name: 'Settings', open: (page) => page.getByRole('button', { name: 'Settings' }).click(), sheet: 'Add expense category' },
];

for (const screen of screens) {
  test(`no horizontal overflow on ${screen.name}`, async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Try it with sample data' }).click();
    await screen.open(page);
    const wide = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 && !e.closest('.filter-row'))
          .map((e) => `${e.tagName}.${e.className}`),
      );
    expect(await wide()).toEqual([]);
    expect(await page.evaluate(() => innerWidth)).toBe(412);
    await page.getByRole('button', { name: screen.sheet }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await wide()).toEqual([]);
  });
}

test('no horizontal overflow on the monthly tracker and a person', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Try it with sample data' }).click();
  const wide = () =>
    page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => `${e.tagName}.${e.className}`));
  await page.getByRole('navigation').getByRole('button', { name: 'Tracker' }).click();
  await page.getByRole('radio', { name: 'Monthly' }).click();
  expect(await wide()).toEqual([]);
  await page.getByRole('navigation').getByRole('button', { name: 'People' }).click();
  await page.getByRole('button', { name: /Rahul/ }).click();
  await expect(page.getByRole('dialog', { name: 'Rahul' })).toBeVisible();
  expect(await wide()).toEqual([]);
});
