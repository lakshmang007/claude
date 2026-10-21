import { expect, test, type Page } from '@playwright/test';

/** A pad name no other test uses. */
const fresh = (name: string) => `/e2e/${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const editor = (page: Page) => page.locator('.editor-host .cm-content');
const padText = (page: Page) => page.evaluate(() => (window as unknown as { runpad: { main: { text: { toString(): string } } } }).runpad.main.text.toString());

async function openPad(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('.conn.online')).toBeVisible();
}

test('home page opens a pad by name', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('runs your code');
  const name = fresh('home').slice(1);
  await page.getByLabel('Pad name').fill(name);
  await page.getByRole('button', { name: 'Open pad' }).click();
  await expect(page).toHaveURL(new RegExp(name.replace(/\//g, '\\/') + '$'));
  await expect(page.locator('.crumb.current')).toHaveText(name.split('/').pop()!);
});

test('text is saved and shared live, and readable with curl', async ({ page, browser, request }) => {
  const path = fresh('live');
  await openPad(page, path);
  await editor(page).click();
  await page.keyboard.type('shared notes');

  const other = await (await browser.newContext()).newPage();
  await openPad(other, path);
  await expect(editor(other)).toContainText('shared notes');
  await editor(other).click();
  await other.keyboard.press('Control+End');
  await other.keyboard.type(' + more');
  await expect(editor(page)).toContainText('shared notes + more');
  await expect(page.locator('.people .avatar')).toHaveCount(1);

  await expect.poll(async () => (await request.get(path)).text()).toBe('shared notes + more');
  await page.reload();
  await expect(editor(page)).toContainText('shared notes + more');
});

test('runs a program with typed input', async ({ page }) => {
  await openPad(page, fresh('run'));
  await page.getByRole('button', { name: 'Python', exact: true }).click();
  await expect(page.locator('.lang-select')).toHaveValue('python');
  await page.keyboard.press('Control+Enter');
  const input = page.getByLabel('Program input');
  await expect(input).toBeVisible();
  await expect(page.locator('.output-panel .console-pre')).toContainText("What's your name?");
  await input.fill('Ada');
  await input.press('Enter');
  await expect(page.locator('.output-panel .console-pre')).toContainText('Hello, Ada!');
  await expect(page.locator('.run-status.ok')).toContainText('Exited with code 0');
});

test('uses the Input tab as stdin and links compile errors to lines', async ({ page }) => {
  await openPad(page, fresh('prog.c'));
  await editor(page).click();
  await page.evaluate(() => {
    const m = (window as unknown as { runpad: { main: { text: { insert(i: number, s: string): void } } } }).runpad.main;
    m.text.insert(0, '#include <stdio.h>\nint main(void) {\n    int n;\n    scanf("%d", &n);\n    printf("%d\\n", n * n);\n    return missing;\n}\n');
  });
  await expect(page.locator('.lang-select')).toHaveValue('auto');
  await page.getByRole('tab', { name: 'Input' }).click();
  await page.locator('.stdin-editor .cm-content').click();
  await page.keyboard.type('12');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('.run-status.fail')).toContainText('Compilation failed');
  await page.locator('a.file-ref').first().click();
  const line = await page.evaluate(() => {
    const v = (window as unknown as { runpad: { view: { state: { doc: { lineAt(p: number): { number: number } }; selection: { main: { head: number } } } } } }).runpad.view;
    return v.state.doc.lineAt(v.state.selection.main.head).number;
  });
  expect(line).toBe(6);
  await page.keyboard.press('End');
  for (let i = 0; i < 'missing;'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('0;');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.output-panel .console-pre')).toContainText('144');
  await expect(page.locator('.run-status.ok')).toBeVisible();
});

test('attached files and the terminal', async ({ page }) => {
  const path = fresh('proj');
  await openPad(page, path);
  await page.getByRole('button', { name: 'Python', exact: true }).click();
  await page.locator('.tab-add').click();
  await page.getByRole('menuitem', { name: 'New file…' }).click();
  await page.getByLabel('File name').fill('helper.py');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.tab-wrap.selected')).toContainText('helper.py');
  await editor(page).click();
  await page.keyboard.type('GREETING = "hi from helper"\n');
  await page.locator('.tab', { hasText: path.split('/').pop()! }).click();
  await page.evaluate(() => {
    const m = (window as unknown as { runpad: { main: { text: { length: number; delete(i: number, n: number): void; insert(i: number, s: string): void } } } }).runpad.main;
    m.text.delete(0, m.text.length);
    m.text.insert(0, 'from helper import GREETING\nprint(GREETING)\n');
  });
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.output-panel .console-pre')).toContainText('hi from helper');

  await page.getByRole('tab', { name: 'Terminal' }).click();
  const term = page.getByLabel('Terminal command');
  await term.fill('ls && echo 5 > n.txt');
  await term.press('Enter');
  await expect(page.locator('.terminal-panel .console-pre')).toContainText('helper.py');
  await term.fill('cat n.txt; read x; echo "you said $x"');
  await term.press('Enter');
  await term.fill('hello');
  await term.press('Enter');
  await expect(page.locator('.terminal-panel .console-pre')).toContainText('you said hello');
});

test('locking makes a pad read-only for others', async ({ page, browser }) => {
  const path = fresh('locked');
  await openPad(page, path);
  await editor(page).click();
  await page.keyboard.type('only I may edit');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Lock with password/ }).click();
  await page.getByLabel('Password', { exact: true }).fill('hunter22');
  await page.getByLabel('Repeat password').fill('hunter22');
  await page.getByRole('button', { name: 'Lock pad' }).click();
  await expect(page.locator('.lock-badge')).toContainText('Read-only');

  const other = await (await browser.newContext()).newPage();
  await openPad(other, path);
  await expect(other.locator('.banner')).toContainText('Read-only');
  await editor(other).click();
  await other.keyboard.type('vandalism');
  await expect(editor(other)).not.toContainText('vandalism');

  await other.getByRole('button', { name: 'Unlock to edit' }).click();
  await other.getByPlaceholder('Password').fill('hunter22');
  await other.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(other.locator('.banner')).toBeHidden();
  await editor(other).click();
  await other.keyboard.press('Control+End');
  await other.keyboard.type('!');
  await expect(editor(page)).toContainText('only I may edit!');
});

test('private pads ask for the password first', async ({ page, browser }) => {
  const path = fresh('private');
  await openPad(page, path);
  await editor(page).click();
  await page.keyboard.type('diary');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Lock with password/ }).click();
  await page.getByText('Private', { exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill('hunter22');
  await page.getByLabel('Repeat password').fill('hunter22');
  await page.getByRole('button', { name: 'Lock pad' }).click();
  await expect(page.locator('.lock-badge')).toContainText('Private');

  const other = await (await browser.newContext()).newPage();
  await other.goto(path);
  await expect(other.locator('.locked-card')).toContainText('This pad is private.');
  await other.getByPlaceholder('Password').fill('hunter22');
  await other.getByRole('button', { name: 'Unlock' }).click();
  await expect(editor(other)).toContainText('diary');
});

test('history shows changes and restores', async ({ page }) => {
  const path = fresh('hist');
  await openPad(page, path);
  await page.request.post(path, { data: 'version one\n' });
  await page.request.post(path, { data: 'version two\n' });
  await expect(editor(page)).toContainText('version two');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Version history/ }).click();
  await page.locator('.history-list [role=option]').last().click();
  await expect(page.locator('.diff-del')).toContainText('version one');
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await expect(editor(page)).toContainText('version one');
  expect(await padText(page)).toBe('version one\n');
});

test('markdown and HTML previews', async ({ page }) => {
  await openPad(page, fresh('notes.md'));
  await editor(page).click();
  await page.keyboard.type('# Title\n\nSome **bold** text');
  await expect(page.locator('.markdown-body h1')).toHaveText('Title');
  await expect(page.locator('.markdown-body strong')).toHaveText('bold');

  await openPad(page, fresh('site'));
  await page.getByRole('button', { name: 'HTML', exact: true }).click();
  const frame = page.frameLocator('.preview-frame');
  await expect(frame.locator('h1')).toHaveText('Hello!');
  await frame.locator('button').click();
  await expect(frame.locator('button')).toHaveText('Clicked 1 times');
});

test('works on a phone-sized screen', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true })).newPage();
  await openPad(page, fresh('phone'));
  await page.getByRole('button', { name: 'Python', exact: true }).tap();
  await page.getByRole('tab', { name: 'Input' }).tap();
  await page.locator('.stdin-editor .cm-content').tap();
  await page.keyboard.type('Sam');
  await page.getByRole('button', { name: 'Run' }).tap();
  await expect(page.locator('.output-panel .console-pre')).toContainText('Hello, Sam!');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
