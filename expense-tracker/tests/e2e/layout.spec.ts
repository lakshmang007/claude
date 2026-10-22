import { expect, test } from '@playwright/test';
// Every screen and sheet must fit the phone's width.
for (const tab of ['Home', 'History', 'Stats', 'Settings']) {
  test(`no horizontal overflow on ${tab}`, async ({ page }) => {
    await page.goto('./');
    await page.getByRole('button', { name: 'Try it with sample data' }).click();
    await page.getByRole('navigation').getByRole('button', { name: tab }).click();
    const wide = () => page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5 && !e.closest('.filter-row')).map((e) => `${e.tagName}.${e.className}`));
    expect(await wide()).toEqual([]);
    expect(await page.evaluate(() => innerWidth)).toBe(412);
    await page.getByRole('button', { name: 'Add transaction' }).or(page.getByRole('button', { name: 'Add expense category' })).first().click();
    expect(await wide()).toEqual([]);
  });
}
