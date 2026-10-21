import { h, icon } from '../util';

export interface MenuItem {
  label: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  action: () => void;
}

/** Opens a dropdown menu under `anchor`. Arrow keys move, Esc closes. */
export function openMenu(anchor: HTMLElement, items: Array<MenuItem | 'separator'>): void {
  document.querySelector('.menu-popup')?.remove();
  const menu = h('div.menu-popup', { role: 'menu' });
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    const btn = h(
      'button.menu-item',
      { type: 'button', role: 'menuitem', disabled: item.disabled, class: item.danger ? 'danger' : null },
      item.icon ? icon(item.icon, 15) : h('span.icon-space'),
      h('span.menu-label', null, item.label),
      item.hint ? h('span.menu-hint', null, item.hint) : null,
    ) as HTMLButtonElement;
    btn.addEventListener('click', () => {
      close();
      item.action();
    });
    buttons.push(btn);
    menu.append(btn);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)))}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onKey = (e: KeyboardEvent) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      const pos = enabled.indexOf(buttons[i]);
      const next = e.key === 'ArrowDown' ? enabled[(pos + 1) % enabled.length] : enabled[(pos - 1 + enabled.length) % enabled.length];
      next?.focus();
    } else if (e.key === 'Tab') close();
  };
  const onDown = (e: Event) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', close);
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', close);
  buttons.find((b) => !b.disabled)?.focus();
}
