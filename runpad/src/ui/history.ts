import { api, type HistoryItem } from '../api';
import { diffLines } from '../diff';
import { formatBytes, h, timeAgo, toast } from '../util';
import { openDialog } from './dialog';

/** Version history: pick a snapshot, compare it with the current text, restore it. */
export async function openHistory(opts: { path: string; current: () => string; canWrite: boolean }): Promise<void> {
  const d = openDialog(`History of /${opts.path}`, { wide: true, className: 'history-dialog' });
  const list = h('ul.history-list', { role: 'listbox', 'aria-label': 'Versions' });
  const view = h('pre.history-view');
  const info = h('div.history-info');
  const modeChanges = h('button.btn.small.toggle', { type: 'button', 'aria-pressed': 'true' }, 'Changes since');
  const modeFull = h('button.btn.small.toggle', { type: 'button', 'aria-pressed': 'false' }, 'Full text');
  const restore = h('button.btn.primary', { type: 'button', disabled: true }, 'Restore this version');
  d.body.append(h('div.history-layout', null, list, h('div.history-main', null, h('div.history-bar', null, info, h('div.seg', null, modeChanges, modeFull)), view)));
  d.footer.append(h('span.hint', null, opts.canWrite ? 'Restoring keeps the current text in history too.' : 'This pad is locked; unlock it to restore.'), h('button.btn', { type: 'button', onclick: () => d.close() }, 'Close'), restore);

  let items: HistoryItem[] = [];
  let selected: { id: number; text: string } | null = null;
  let showChanges = true;

  const render = () => {
    if (!selected) return;
    view.replaceChildren();
    if (!showChanges) {
      view.textContent = selected.text;
      return;
    }
    const diff = diffLines(selected.text.split('\n'), opts.current().split('\n'));
    if (!diff) {
      view.textContent = selected.text;
      return;
    }
    if (diff.every((l) => l.op === ' ')) {
      view.append(h('div.diff-note', null, 'Same as the current text.'));
      return;
    }
    // Show changed lines with three lines of context.
    const keep = diff.map((l, i) => l.op !== ' ' || diff.slice(Math.max(0, i - 3), i + 4).some((x) => x.op !== ' '));
    let skipped = false;
    diff.forEach((l, i) => {
      if (!keep[i]) {
        if (!skipped) view.append(h('div.diff-skip', null, '⋯'));
        skipped = true;
        return;
      }
      skipped = false;
      const cls = l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : 'diff-same';
      view.append(h(`div.${cls}` as 'div', null, `${l.op} ${l.text}`));
    });
  };

  modeChanges.addEventListener('click', () => {
    showChanges = true;
    modeChanges.setAttribute('aria-pressed', 'true');
    modeFull.setAttribute('aria-pressed', 'false');
    render();
  });
  modeFull.addEventListener('click', () => {
    showChanges = false;
    modeFull.setAttribute('aria-pressed', 'true');
    modeChanges.setAttribute('aria-pressed', 'false');
    render();
  });

  const select = async (item: HistoryItem, li: HTMLElement) => {
    for (const el of list.children) el.setAttribute('aria-selected', String(el === li));
    info.textContent = `${new Date(item.t).toLocaleString()} · ${item.lines} lines · ${formatBytes(item.size)}`;
    view.textContent = 'Loading…';
    try {
      selected = await api.historyItem(opts.path, item.id);
      modeChanges.textContent = 'Changes since then';
      restore.toggleAttribute('disabled', !opts.canWrite);
      render();
    } catch (err) {
      view.textContent = (err as Error).message;
    }
  };

  restore.addEventListener('click', async () => {
    if (!selected) return;
    try {
      await api.restore(opts.path, selected.id);
      toast('Version restored', 'success');
      d.close();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });

  try {
    items = await api.history(opts.path);
  } catch (err) {
    list.append(h('li.side-empty', null, (err as Error).message));
    return;
  }
  if (!items.length) {
    list.append(h('li.side-empty', null, 'No saved versions yet. Versions are kept automatically every couple of minutes while a pad changes.'));
    view.textContent = '';
    return;
  }
  for (const item of items) {
    const li = h('li', { role: 'option', tabindex: '0' }, h('strong', null, timeAgo(item.t)), h('span', null, `${item.lines} lines · ${formatBytes(item.size)}`));
    li.addEventListener('click', () => select(item, li));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(item, li);
      } else if (e.key === 'ArrowDown') (li.nextElementSibling as HTMLElement | null)?.focus();
      else if (e.key === 'ArrowUp') (li.previousElementSibling as HTMLElement | null)?.focus();
    });
    list.append(li);
  }
  select(items[0], list.firstElementChild as HTMLElement);
}
