import { normalizePadPath, padUrl, parentPath } from '../../shared/padpath.js';
import { api, type ChildPad } from '../api';
import { forgetPad, recentPads } from '../recent';
import { formatBytes, h, icon, timeAgo } from '../util';

/**
 * Left sidebar: the pad's sub-pads (like Dontpad's subpage list), a box to create one,
 * and recently visited pads.
 */
export class Sidebar {
  readonly el: HTMLElement;
  #list: HTMLElement;
  #recent: HTMLElement;
  #count: HTMLElement;
  #timer: ReturnType<typeof setInterval> | undefined;
  children: ChildPad[] = [];

  constructor(
    private opts: {
      path: string;
      isAttachable: (name: string) => boolean;
      onOpenFile: (child: ChildPad) => void;
      onChildren: (children: ChildPad[]) => void;
    },
  ) {
    const parent = parentPath(opts.path);
    this.#list = h('ul.side-list', { 'aria-label': 'Sub-pads' });
    this.#recent = h('ul.side-list.recent', { 'aria-label': 'Recent pads' });
    this.#count = h('span.count');
    const input = h('input.input.small', { type: 'text', placeholder: 'name', 'aria-label': 'New sub-pad name', maxlength: '100' }) as HTMLInputElement;
    const form = h('form.side-new', null, h('span.side-prefix', null, '/…/'), input, h('button.btn.small', { type: 'submit' }, 'Open'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input.value.trim();
      const target = name && normalizePadPath(`${opts.path}/${name}`, { decoded: true });
      if (target) location.href = padUrl(target);
      else input.setCustomValidity('Not a valid name');
      input.reportValidity();
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    const refresh = h('button.icon-btn.small', { type: 'button', title: 'Refresh', 'aria-label': 'Refresh sub-pads' }, icon('refresh', 14));
    refresh.addEventListener('click', () => this.refresh());

    this.el = h(
      'aside.sidebar',
      { 'aria-label': 'Pads' },
      parent ? h('a.side-up', { href: padUrl(parent) }, icon('up', 14), `/${parent}`) : null,
      h('div.side-head', null, h('h3', null, 'Sub-pads ', this.#count), refresh),
      this.#list,
      form,
      h('p.side-hint', null, 'Sub-pads with file names (like util.h or input.txt) are attached files: they open as tabs and are copied next to your program when it runs.'),
      h('div.side-head', null, h('h3', null, 'Recent')),
      this.#recent,
    );
    this.renderRecent();
    this.#timer = setInterval(() => {
      // Also while hidden: the list drives the attached-file tabs.
      if (document.visibilityState === 'visible') this.refresh();
    }, 15_000);
  }

  async refresh(): Promise<void> {
    try {
      this.children = await api.children(this.opts.path);
    } catch {
      this.children = [];
    }
    this.opts.onChildren(this.children);
    this.#render();
  }

  #render(): void {
    this.#count.textContent = this.children.length ? String(this.children.length) : '';
    if (!this.children.length) {
      this.#list.replaceChildren(h('li.side-empty', null, 'No sub-pads yet.'));
      return;
    }
    this.#list.replaceChildren(
      ...this.children.map((c) => {
        const attachable = c.exists && this.opts.isAttachable(c.name);
        const meta = [c.exists ? formatBytes(c.size) : 'folder', c.updatedAt ? timeAgo(c.updatedAt) : ''].filter(Boolean).join(' · ');
        const link = h(
          'a.side-item',
          { href: padUrl(c.path), title: attachable ? `Open ${c.name} in a tab (Shift+click for its own page)` : `Open /${c.path}` },
          icon(c.hasChildren && !attachable ? 'folder' : 'file', 15),
          h('span.side-name', null, c.name),
          c.locked ? icon('lock', 12) : null,
          h('span.side-meta', null, meta),
        );
        if (attachable) {
          link.addEventListener('click', (e) => {
            if (e.shiftKey || e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            this.opts.onOpenFile(c);
          });
        }
        return h('li', null, link);
      }),
    );
  }

  renderRecent(): void {
    const list = recentPads().filter((r) => r.path !== this.opts.path).slice(0, 12);
    if (!list.length) {
      this.#recent.replaceChildren(h('li.side-empty', null, 'Pads you open show up here.'));
      return;
    }
    this.#recent.replaceChildren(
      ...list.map((r) => {
        const remove = h('button.icon-btn.tiny', { type: 'button', title: 'Remove from recent', 'aria-label': `Remove /${r.path} from recent` }, icon('x', 12));
        remove.addEventListener('click', (e) => {
          e.preventDefault();
          forgetPad(r.path);
          this.renderRecent();
        });
        return h('li', null, h('a.side-item', { href: padUrl(r.path) }, h('span.side-name', null, `/${r.path}`), h('span.side-meta', null, timeAgo(r.t))), remove);
      }),
    );
  }

  destroy(): void {
    clearInterval(this.#timer);
  }
}
