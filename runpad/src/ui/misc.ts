import { padUrl } from '../../shared/padpath.js';
import { COLORS, settings, type Settings } from '../settings';
import { setRunKey } from '../tokens';
import { copyText, h, modKey, toast } from '../util';
import { openDialog, promptDialog } from './dialog';

export function openSettings(): void {
  const d = openDialog('Settings');
  const s = settings.value;
  const select = (label: string, key: keyof Settings, options: Array<[string, string]>) => {
    const el = h('select.input', { 'aria-label': label }) as HTMLSelectElement;
    for (const [value, text] of options) el.append(h('option', { value, selected: String(s[key]) === value }, text));
    el.addEventListener('change', () => settings.update({ [key]: typeof s[key] === 'number' ? Number(el.value) : el.value } as Partial<Settings>));
    return h('label.field.row', null, h('span', null, label), el);
  };
  const check = (label: string, key: 'wrap' | 'lineNumbers') => {
    const el = h('input', { type: 'checkbox', checked: s[key] }) as HTMLInputElement;
    el.addEventListener('change', () => settings.update({ [key]: el.checked }));
    return h('label.check', null, el, h('span', null, label));
  };
  const name = h('input.input', { type: 'text', value: s.name, maxlength: '40', 'aria-label': 'Your name' }) as HTMLInputElement;
  name.addEventListener('change', () => settings.update({ name: name.value.trim() || s.name }));
  const swatches = h('div.swatches', { role: 'radiogroup', 'aria-label': 'Cursor colour' });
  for (const c of COLORS) {
    const b = h('button.swatch', { type: 'button', style: `background:${c}`, 'aria-label': c, 'aria-checked': String(c === settings.value.color), role: 'radio' });
    b.addEventListener('click', () => {
      settings.update({ color: c });
      for (const x of swatches.children) x.setAttribute('aria-checked', String(x === b));
    });
    swatches.append(b);
  }
  d.body.append(
    h('h3', null, 'Editor'),
    select('Theme', 'theme', [['system', 'Same as system'], ['light', 'Light'], ['dark', 'Dark']]),
    select('Font size', 'fontSize', [11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map((n) => [String(n), `${n} px`])),
    select('Tab width', 'tabSize', [['2', '2 spaces'], ['4', '4 spaces'], ['8', '8 spaces']]),
    check('Wrap long lines', 'wrap'),
    check('Show line numbers', 'lineNumbers'),
    h('h3', null, 'You'),
    h('label.field.row', null, h('span', null, 'Name shown to others'), name),
    h('div.field.row', null, h('span', null, 'Cursor colour'), swatches),
    h('h3', null, 'Running code'),
    h(
      'p.hint',
      null,
      'If the server asks for a run key, it is stored in this browser. ',
      h('button.link-btn', {
        type: 'button',
        onclick: async () => {
          const key = await promptDialog('Run key', 'Run key', { type: 'password', okLabel: 'Save' });
          if (key !== null) {
            setRunKey(key);
            toast('Run key saved', 'success');
          }
        },
      }, 'Enter a run key'),
    ),
  );
  d.footer.append(h('button.btn.primary', { type: 'button', onclick: () => d.close() }, 'Done'));
}

export function openShortcuts(): void {
  const d = openDialog('Keyboard shortcuts');
  const rows: Array<[string, string]> = [
    [`${modKey}+Enter`, 'Run the program'],
    [`${modKey}+Shift+Enter`, 'Stop the running program'],
    [`${modKey}+S`, 'Save now (pads save automatically)'],
    [`${modKey}+J`, 'Show or hide the output panel'],
    [`${modKey}+\``, 'Open the terminal'],
    [`${modKey}+B`, 'Show or hide the sidebar'],
    [`${modKey}+F`, 'Find'],
    [`${modKey}+Alt+F / ${modKey}+H`, 'Find and replace'],
    [`${modKey}+Z / ${modKey}+Shift+Z`, 'Undo / redo your own changes'],
    [`${modKey}+/`, 'Comment out lines'],
    ['Alt+↑ / Alt+↓', 'Move lines up / down'],
    ['Tab / Shift+Tab', 'Indent / outdent (press Esc first to move focus out)'],
    ['Enter (output panel)', 'Send a line of input to the running program'],
    ['Ctrl+D (output panel)', 'End the program’s input'],
    ['Ctrl+C (terminal)', 'Stop the running command'],
  ];
  d.body.append(h('table.shortcuts', null, h('tbody', null, ...rows.map(([k, v]) => h('tr', null, h('td', null, ...k.split(' / ').flatMap((part, i) => [i ? ' / ' : '', h('kbd', null, part)])), h('td', null, v))))));
  d.footer.append(h('button.btn.primary', { type: 'button', onclick: () => d.close() }, 'Close'));
}

/** How to use a pad from the command line. */
export function openCli(path: string): void {
  const d = openDialog('Use from the command line', { wide: true });
  const url = `${location.origin}${padUrl(path)}`;
  const examples: Array<[string, string]> = [
    ['Print the pad', `curl ${url}`],
    ['Replace it with a file', `curl --data-binary @main.c ${url}`],
    ['Append a line', `echo "hello" | curl --data-binary @- "${url}?append"`],
    ['Download it as a file', `curl -OJ "${url}?download"`],
    ['Download it with its sub-pads (.zip)', `curl -OJ ${location.origin}/_api/zip${padUrl(path)}`],
  ];
  d.body.append(h('p', null, 'Every pad is also plain text at its address. Locked pads need a token: add the header ', h('code', null, 'X-Pad-Tokens: <token>'), '.'));
  for (const [label, cmd] of examples) {
    const copy = h('button.btn.small', { type: 'button' }, 'Copy');
    copy.addEventListener('click', async () => toast((await copyText(cmd)) ? 'Copied' : 'Could not copy', 'success', 1500));
    d.body.append(h('div.cli-row', null, h('span.cli-label', null, label), h('div.cli-cmd', null, h('code', null, cmd), copy)));
  }
  d.footer.append(h('button.btn.primary', { type: 'button', onclick: () => d.close() }, 'Close'));
}

export function openAbout(info: { sandbox?: string; languages: Array<{ name: string; version: string }>; limits?: { runSeconds: number; cpuSeconds: number; memoryMb: number; outputKb: number } } | null): void {
  const d = openDialog('About RunPad', { wide: true });
  d.body.append(
    h('p', null, 'RunPad is a shared notepad in the spirit of Dontpad: any address is a pad, there are no accounts, and whatever you type is saved and shared live with everyone on the same address. On top of that it can run code, has a terminal, keeps version history, and lets you lock pads with a password.'),
  );
  if (info && info.languages.length) {
    d.body.append(
      h('h3', null, 'Languages on this server'),
      h('table.langs', null, h('tbody', null, ...info.languages.map((l) => h('tr', null, h('td', null, l.name), h('td', null, h('code', null, l.version)))))),
    );
    if (info.limits) {
      d.body.append(
        h('h3', null, 'Limits'),
        h('p.hint', null, `Programs get ${info.limits.cpuSeconds} s of CPU time and ${info.limits.runSeconds} s in total (longer while waiting for typed input), about ${info.limits.memoryMb} MB of memory and ${info.limits.outputKb} KB of output. Sandbox: ${info.sandbox ?? 'unknown'}.`),
      );
    }
  } else {
    d.body.append(h('p.hint', null, 'Running code is turned off on this server.'));
  }
  d.footer.append(h('button.btn.primary', { type: 'button', onclick: () => d.close() }, 'Close'));
}
