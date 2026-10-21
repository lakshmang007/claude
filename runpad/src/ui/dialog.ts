import { h, icon } from '../util';

/** Modal dialogs built on <dialog>. */

export interface DialogHandle {
  el: HTMLDialogElement;
  body: HTMLElement;
  footer: HTMLElement;
  close(): void;
  closed: Promise<void>;
}

export function openDialog(title: string, opts: { wide?: boolean; className?: string } = {}): DialogHandle {
  const body = h('div.dialog-body');
  const footer = h('div.dialog-footer');
  const closeBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, icon('x'));
  const el = h(
    'dialog.dialog',
    { class: [opts.wide ? 'wide' : '', opts.className ?? ''].join(' ').trim() || null, 'aria-label': title },
    h('div.dialog-header', null, h('h2', null, title), closeBtn),
    body,
    footer,
  ) as HTMLDialogElement;
  let resolve!: () => void;
  const closed = new Promise<void>((r) => (resolve = r));
  const close = () => el.close();
  closeBtn.addEventListener('click', close);
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
  el.addEventListener('close', () => {
    el.remove();
    resolve();
  });
  document.body.append(el);
  el.showModal();
  return { el, body, footer, close, closed };
}

/** Asks a yes/no question. */
export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  const d = openDialog(title);
  d.body.append(h('p', null, message));
  let result = false;
  const ok = h(danger ? 'button.btn.danger' : 'button.btn.primary', { type: 'button' }, okLabel);
  ok.addEventListener('click', () => {
    result = true;
    d.close();
  });
  d.footer.append(h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel'), ok);
  ok.focus();
  return d.closed.then(() => result);
}

/** Asks for one line of text. Resolves null when cancelled. */
export function promptDialog(title: string, label: string, opts: { value?: string; placeholder?: string; okLabel?: string; type?: string; hint?: string } = {}): Promise<string | null> {
  const d = openDialog(title);
  const input = h('input.input', { type: opts.type ?? 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '', 'aria-label': label }) as HTMLInputElement;
  const form = h('form', null, h('label.field', null, h('span', null, label), input), opts.hint ? h('p.hint', null, opts.hint) : null);
  let result: string | null = null;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    result = input.value;
    d.close();
  });
  d.body.append(form);
  d.footer.append(
    h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel'),
    h('button.btn.primary', { type: 'button', onclick: () => form.requestSubmit() }, opts.okLabel ?? 'OK'),
  );
  input.focus();
  input.select();
  return d.closed.then(() => result);
}
