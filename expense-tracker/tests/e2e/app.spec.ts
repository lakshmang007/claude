import { expect, test, type Page } from '@playwright/test';

async function addTransaction(page: Page, { amount, category, note, income }: { amount: string; category: string; note?: string; income?: boolean }) {
  const first = page.getByRole('button', { name: 'Add your first expense' });
  if (await first.isVisible()) await first.click();
  else await page.getByRole('button', { name: 'Add transaction' }).click();
  const sheet = page.getByRole('dialog');
  if (income) await sheet.getByRole('radio', { name: 'Income' }).click();
  await sheet.getByLabel('Amount').fill(amount);
  await sheet.getByRole('button', { name: category, exact: true }).click();
  if (note) await sheet.getByLabel('Note').fill(note);
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
});

test('records an expense and an income and shows the month balance', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Know where your money goes' })).toBeVisible();
  await expect(page.getByLabel('Your currency')).toHaveValue('INR');

  await addTransaction(page, { amount: '250', category: 'Food & dining', note: 'Biryani' });
  await expect(page.getByRole('status')).toContainText('Spent ₹250 · Food & dining');
  await addTransaction(page, { amount: '1,000.50', category: 'Allowance', income: true });

  const balance = page.getByRole('region', { name: 'This month' });
  await expect(balance).toContainText('+₹750.50');
  await expect(balance).toContainText('₹1,000.50');
  await expect(page.getByRole('button', { name: /Biryani Food & dining −₹250/ })).toBeVisible();

  // Survives a reload.
  await page.reload();
  await expect(page.getByRole('region', { name: 'This month' })).toContainText('+₹750.50');
});

test('explains what is missing instead of saving a bad entry', async ({ page }) => {
  await page.getByRole('button', { name: 'Add your first expense' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('Enter an amount');
  await sheet.getByLabel('Amount').fill('12.345');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet.getByRole('alert')).toContainText('Enter an amount');
  await sheet.getByLabel('Amount').fill('12.34');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Pick a category.');
});

test('edits, deletes and undoes', async ({ page }) => {
  await addTransaction(page, { amount: '99', category: 'Transport', note: 'Auto' });
  await page.getByRole('button', { name: /Auto Transport/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit transaction' });
  await expect(sheet.getByLabel('Amount')).toHaveValue('99');
  await sheet.getByLabel('Amount').fill('120');
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: /Auto Transport −₹120/ })).toBeVisible();

  await page.getByRole('button', { name: /Auto Transport/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: /Auto Transport/ })).toBeHidden();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /Auto Transport −₹120/ })).toBeVisible();
});

test('the back button closes a sheet, then returns home, without leaving the app', async ({ page }) => {
  await addTransaction(page, { amount: '10', category: 'Groceries' });
  await page.getByRole('button', { name: 'Stats' }).last().click();
  await expect(page.getByRole('heading', { name: 'Stats', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Stats', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Expense Tracker', level: 1 })).toBeVisible();

  // Closing with the X also leaves history as it was.
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Expense Tracker', level: 1 })).toBeVisible();
});

test('sample data fills the stats, and a category opens its transactions', async ({ page }) => {
  await page.getByRole('button', { name: 'Try it with sample data' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Stats' }).click();
  await expect(page.getByRole('heading', { name: 'Where it went' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Spending in each of the last months' })).toBeVisible();
  await expect(page.locator('.month-table tbody tr')).toHaveCount(6);

  await page.locator('.cat-bars').getByRole('button', { name: /Groceries/ }).click();
  await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Category')).toHaveValue('exp-groceries');
  const rows = page.locator('.tx-row');
  await expect(rows.first()).toContainText('Groceries');
  expect(await rows.count()).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Search transactions').fill('movie');
  await expect(rows.first()).toContainText('Movie');
});

test('budgets warn as spending nears and passes the limit', async ({ page }) => {
  await addTransaction(page, { amount: '850', category: 'Shopping' });
  await page.getByRole('button', { name: 'Set a monthly budget' }).click();
  await page.getByLabel('Monthly budget').fill('1000');
  await page.getByLabel('Monthly budget').press('Enter');
  await expect(page.getByRole('status')).toContainText('Monthly budget saved');

  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  const meter = page.getByRole('meter', { name: 'Monthly budget' });
  await expect(meter).toHaveAttribute('aria-valuetext', '₹850 of ₹1,000');
  await expect(page.locator('.meter')).toContainText('85% used');

  await addTransaction(page, { amount: '200', category: 'Shopping' });
  await expect(page.locator('.meter')).toContainText('₹50 over');
  await expect(page.locator('.meter')).toContainText('Over budget');
});

test('backs up, erases and restores', async ({ page }) => {
  await addTransaction(page, { amount: '42', category: 'Health', note: 'Vitamins' });
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up' }).click();
  const file = await (await download).path();

  await page.getByRole('button', { name: 'Erase everything' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erase' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Know where your money goes' })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
  await page.locator('input[type=file]').setInputFiles(file);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('It has 1 transactions');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('button', { name: /Vitamins Health −₹42/ })).toBeVisible();
});

test('exports a CSV', async ({ page }) => {
  await addTransaction(page, { amount: '15.75', category: 'Food & dining', note: 'Chai, samosa' });
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await (await download).createReadStream();
  const text = await new Promise<string>((resolve) => {
    let body = '';
    csv.on('data', (chunk) => (body += chunk));
    csv.on('end', () => resolve(body));
  });
  expect(text).toContain('Expense,Food & dining,15.75,INR,"Chai, samosa"');
});

test('custom categories can be added, used and deleted', async ({ page }) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Add expense category' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Name').fill('Pets');
  await sheet.getByRole('button', { name: '🐶' }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /Pets/ })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await addTransaction(page, { amount: '300', category: 'Pets', note: 'Dog food' });
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Pets/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Its 1 transaction will move to Other.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('button', { name: /Dog food Other −₹300/ })).toBeVisible();
});

test('switches theme', async ({ page }) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(15, 15, 14)');
  await page.getByRole('radio', { name: 'Auto' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
});

test('installs as an offline app', async ({ page, context }) => {
  const manifest = await (await page.request.get('./manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);

  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Know where your money goes' })).toBeVisible();
  await context.setOffline(false);
});
