import { expect, test, type Page } from '@playwright/test';

async function addTransaction(page: Page, { amount, category, note, income }: { amount: string; category: string; note?: string; income?: boolean }) {
  await page.getByRole('button', { name: 'Add transaction' }).click();
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
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Add expense' }).click();
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
  await page.getByRole('navigation').getByRole('button', { name: 'Tracker' }).click();
  await expect(page.getByRole('heading', { name: 'Tracker', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Tracker', level: 1 })).toBeVisible();

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
  await page.getByRole('navigation').getByRole('button', { name: 'Tracker' }).click();
  await page.getByRole('radio', { name: 'Monthly' }).click();
  await expect(page.getByRole('heading', { name: 'Where it went' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Spending in each of the last 6 months' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Settings' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up' }).click();
  const file = await (await download).path();

  await page.getByRole('button', { name: 'Erase everything' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Erase' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('input[type=file]').setInputFiles(file);
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('It has 1 transactions');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('button', { name: /Vitamins Health −₹42/ })).toBeVisible();
});

test('exports a CSV', async ({ page }) => {
  await addTransaction(page, { amount: '15.75', category: 'Food & dining', note: 'Chai, samosa' });
  await page.getByRole('button', { name: 'Settings' }).click();
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
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Add expense category' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Name').fill('Pets');
  await sheet.getByRole('button', { name: '🐶' }).click();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: /Pets/ })).toBeVisible();

  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await addTransaction(page, { amount: '300', category: 'Pets', note: 'Dog food' });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Pets/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Its 1 transaction will move to Other.');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('button', { name: /Dog food Other −₹300/ })).toBeVisible();
});

test('switches theme', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
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
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible();
  await context.setOffline(false);
});

test('keeps a running total: set it, add money, add expenses, correct it', async ({ page }) => {
  const wallet = page.getByRole('region', { name: 'Money you have' });
  await expect(wallet).toContainText('₹0');
  await wallet.getByRole('button', { name: 'Set amount' }).click();
  await page.getByLabel('Amount you have').fill('10,000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(wallet).toContainText('₹10,000');

  await wallet.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByRole('dialog', { name: 'Add expense' })).toBeVisible();
  await page.getByLabel('Amount').fill('250');
  await page.getByRole('dialog').getByRole('button', { name: 'Food & dining', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(wallet).toContainText('₹9,750');

  await wallet.getByRole('button', { name: 'Add money' }).click();
  await expect(page.getByRole('dialog', { name: 'Add money' })).toBeVisible();
  await page.getByLabel('Amount').fill('1000');
  await page.getByRole('dialog').getByRole('button', { name: 'Allowance', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Added ₹1,000 · Allowance');
  await expect(wallet).toContainText('₹10,750');

  // Each entry shows what was left after it.
  await expect(page.getByRole('button', { name: /Food & dining −₹250 ₹9,750 left/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Allowance \+₹1,000 ₹10,750 left/ })).toBeVisible();

  // Counting the cash and correcting the total keeps the entries.
  await wallet.getByRole('button', { name: 'Change' }).click();
  await expect(page.getByLabel('Amount you have')).toHaveValue('10750');
  await page.getByLabel('Amount you have').fill('10000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(wallet).toContainText('₹10,000');
  await expect(page.getByRole('button', { name: /Allowance \+₹1,000 ₹10,000 left/ })).toBeVisible();

  // Spending more than you have is flagged.
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByLabel('Amount').fill('12000');
  await page.getByRole('dialog').getByRole('button', { name: 'Rent', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(wallet).toContainText('−₹2,000');
  await expect(wallet).toContainText('You have spent more than you had');

  await page.reload();
  await expect(page.getByRole('region', { name: 'Money you have' })).toContainText('−₹2,000');
});

test('skipped cravings go into savings', async ({ page }) => {
  const wallet = page.getByRole('region', { name: 'Money you have' });
  await wallet.getByRole('button', { name: 'Set amount' }).click();
  await page.getByLabel('Amount you have').fill('500');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await wallet.getByRole('button', { name: 'Skipped a craving? Save it' }).click();
  const sheet = page.getByRole('dialog', { name: 'Skip a craving' });
  await sheet.getByRole('button', { name: 'Add to savings' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Say what you skipped');
  await sheet.getByLabel('What did you skip?').fill('Chocolate cake');
  await sheet.getByLabel('What it would have cost').fill('30');
  await sheet.getByRole('button', { name: 'Add to savings' }).click();
  await expect(page.getByRole('status')).toContainText('₹30 saved by skipping Chocolate cake');

  // The money stays yours, and the jar shows what is set aside.
  await expect(wallet).toContainText('₹500');
  await expect(wallet).toContainText('In savings ₹30');
  await expect(wallet).toContainText('Free to spend ₹470');

  await page.getByRole('navigation').getByRole('button', { name: 'Savings' }).click();
  const jar = page.getByRole('region', { name: 'Savings jar' });
  await expect(jar).toContainText('₹30');
  await expect(jar).toContainText('Cravings skipped1');

  // Skip it again with one tap, then undo.
  await page.getByRole('button', { name: 'Chocolate cake · ₹30' }).click();
  await expect(jar).toContainText('₹60');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(jar).toContainText('Cravings skipped1');

  // Edit and delete from the list.
  await page.getByRole('button', { name: /Chocolate cake Today \+₹30/ }).click();
  await page.getByRole('dialog').getByLabel('What it would have cost').fill('45');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(jar).toContainText('₹45');
  await page.getByRole('button', { name: /Chocolate cake Today \+₹45/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();

  // On the Savings tab, the + button logs a craving.
  await page.getByRole('button', { name: 'Skip a craving' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Skip a craving' })).toBeVisible();
});

test('notes who has to give money back and who you have to pay', async ({ page }) => {
  const wallet = page.getByRole('region', { name: 'Money you have' });
  await wallet.getByRole('button', { name: 'Set amount' }).click();
  await page.getByLabel('Amount you have').fill('1000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await page.getByRole('navigation').getByRole('button', { name: 'People' }).click();
  await expect(page.getByText('Nothing to settle.')).toBeVisible();

  // Lent Rahul 500 from my money.
  await page.getByRole('button', { name: 'They owe me' }).click();
  let sheet = page.getByRole('dialog', { name: 'Money to get back' });
  await sheet.getByLabel('Who has to give you money?').fill('Rahul');
  await sheet.getByLabel('How much').fill('500');
  await sheet.getByLabel('What for?').fill('Concert ticket');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Noted: Rahul has to give you ₹500');

  // Priya paid for my lunch: I owe her, but no money came to me.
  await page.getByRole('button', { name: 'I owe them' }).click();
  sheet = page.getByRole('dialog', { name: 'Money to give' });
  await sheet.getByLabel('Who do you have to give money to?').fill('Priya');
  await sheet.getByLabel('How much').fill('300');
  await sheet.getByRole('checkbox', { name: /I got this money in hand/ }).uncheck();
  await sheet.getByRole('button', { name: 'Save' }).click();

  const owed = page.getByRole('region', { name: 'Money owed' });
  await expect(owed).toContainText('To get back₹500');
  await expect(owed).toContainText('To give₹300');

  // Rahul pays 200 back; the sheet returns to his page.
  await page.getByRole('button', { name: /Rahul/ }).click();
  await page.getByRole('button', { name: 'Got money back' }).click();
  const payment = page.getByRole('dialog', { name: 'Money back from Rahul' });
  await expect(payment.getByLabel('Amount paid back')).toHaveValue('500');
  await payment.getByLabel('Amount paid back').fill('600');
  await payment.getByRole('button', { name: 'Save' }).click();
  await expect(payment.getByRole('alert')).toContainText('Only ₹500 is left on this.');
  await payment.getByLabel('Amount paid back').fill('200');
  await payment.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Got ₹200 back from Rahul. ₹300 still to get back.');
  const rahul = page.getByRole('dialog', { name: 'Rahul' });
  await expect(rahul).toContainText('₹300 left');
  await rahul.getByRole('button', { name: 'Close' }).click();

  // Money you have: 1000 − 500 lent + 200 back. Priya's debt moved no money.
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(wallet).toContainText('₹700');
  await expect(page.getByRole('button', { name: /To get back ₹300\s*To give ₹300/ })).toBeVisible();

  // The rest comes back, and Rahul is settled.
  await page.getByRole('navigation').getByRole('button', { name: 'People' }).click();
  await page.getByRole('button', { name: /Rahul/ }).click();
  await page.getByRole('button', { name: 'Got money back' }).click();
  await page.getByRole('dialog', { name: 'Money back from Rahul' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Rahul has paid you back in full.');
  await expect(page.getByRole('dialog', { name: 'Rahul' })).toContainText('All settled.');
  await page.getByRole('dialog', { name: 'Rahul' }).getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('Settled (1)')).toBeVisible();
  await expect(owed).toContainText('To get back₹0');

  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click();
  await expect(page.getByRole('region', { name: 'Money you have' })).toContainText('₹1,000');
});

test('tracks each day and each month', async ({ page }) => {
  await addTransaction(page, { amount: '120', category: 'Food & dining', note: 'Breakfast' });
  // One for yesterday.
  await page.getByRole('button', { name: 'Add transaction' }).click();
  await page.getByLabel('Amount').fill('80');
  await page.getByRole('dialog').getByRole('button', { name: 'Transport', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yesterday' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await page.getByRole('button', { name: /Spent today ₹120 · 1 entry/ }).click();
  await expect(page.getByRole('heading', { name: 'Tracker', level: 1 })).toBeVisible();
  const day = page.getByRole('region', { name: 'This day' });
  await expect(day).toContainText('Spent today');
  await expect(day).toContainText('₹120');
  await expect(page.getByRole('button', { name: /Breakfast Food & dining −₹120/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Spending on each of the last 7 days' })).toBeVisible();

  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(day).toContainText('Spent yesterday');
  await expect(day).toContainText('₹80');

  await page.getByRole('radio', { name: 'Monthly' }).click();
  await expect(page.getByRole('heading', { name: 'Day by day' })).toBeVisible();
  const todayCell = page.getByRole('button', { name: 'Today: spent ₹120' });
  await expect(todayCell).toBeVisible();
  await todayCell.click();
  await expect(page.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'true');
  await expect(day).toContainText('Spent today');

  // A monthly budget gives each day a share of it.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Monthly budget').fill('3100');
  await page.getByLabel('Monthly budget').press('Enter');
  await page.getByRole('navigation').getByRole('button', { name: 'Tracker' }).click();
  await expect(page.getByRole('meter', { name: 'Daily limit' })).toBeVisible();
});
