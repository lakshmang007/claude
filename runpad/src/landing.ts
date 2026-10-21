import { normalizePadPath, padUrl } from '../shared/padpath.js';
import { api } from './api';
import { forgetPad, recentPads } from './recent';
import { h, icon, timeAgo } from './util';

/** The home page: open a pad by name, recent pads, and what RunPad does. */
export function renderLanding(mount: HTMLElement): void {
  document.title = 'RunPad · shared notepad that runs code';
  const host = location.host;
  const input = h('input.landing-input', {
    type: 'text',
    placeholder: 'your-pad-name',
    'aria-label': 'Pad name',
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: 'false',
    autofocus: true,
  }) as HTMLInputElement;
  const error = h('p.form-error', { role: 'alert' });
  const form = h('form.landing-form', null, h('label.landing-url', null, h('span.landing-host', null, `${host}/`), input), h('button.btn.primary.big', { type: 'submit' }, 'Open pad'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const target = normalizePadPath(input.value.replace(/^\/+/, ''), { decoded: true });
    if (!target) {
      error.textContent = input.value.trim() ? 'That name cannot be used (it may start with "_" or contain "..").' : 'Type a name for your pad.';
      return;
    }
    location.href = padUrl(target);
  });
  input.addEventListener('input', () => (error.textContent = ''));

  const random = h('button.link-btn', { type: 'button' }, 'or make one with a random name');
  random.addEventListener('click', () => {
    const id = Math.random().toString(36).slice(2, 8);
    location.href = padUrl(`pad-${id}`);
  });

  const recent = recentPads();
  const recentList = h('ul.landing-recent');
  const renderRecent = () => {
    const list = recentPads();
    recentList.replaceChildren(
      ...list.slice(0, 10).map((r) => {
        const x = h('button.icon-btn.tiny', { type: 'button', 'aria-label': `Forget /${r.path}`, title: 'Remove from this list' }, icon('x', 12));
        x.addEventListener('click', () => {
          forgetPad(r.path);
          renderRecent();
        });
        return h('li', null, h('a', { href: padUrl(r.path) }, `/${r.path}`), h('span.side-meta', null, timeAgo(r.t)), x);
      }),
    );
    recentSection.hidden = !list.length;
  };
  const recentSection = h('section.landing-section', { hidden: !recent.length }, h('h2', null, 'Your recent pads'), recentList);
  renderRecent();

  const feature = (iconName: string, title: string, text: string) => h('div.feature', null, h('span.feature-icon', null, icon(iconName, 20)), h('h3', null, title), h('p', null, text));
  const langs = h('p.landing-langs');
  api
    .config()
    .then((c) => {
      langs.textContent = c.exec.enabled && c.exec.languages.length ? `Runs here: ${c.exec.languages.map((l) => l.name.replace(' (Node.js)', '')).join(', ')}.` : 'Code execution is turned off on this server.';
    })
    .catch(() => {});

  mount.replaceChildren(
    h(
      'main.landing',
      null,
      h(
        'section.landing-hero',
        null,
        h('div.landing-logo', null, h('span.brand-mark.big', null, icon('play', 20)), h('span', null, 'RunPad')),
        h('h1', null, 'A notepad at any address. That runs your code.'),
        h('p.lead', null, 'Type a name, start writing. Everything is saved as you type and shared live with anyone who opens the same address. No sign-up.'),
        form,
        error,
        h('p.landing-alt', null, random),
        langs,
      ),
      recentSection,
      h(
        'section.landing-section.features',
        null,
        feature('file', 'Any URL is a pad', `${host}/anything works, and so does ${host}/class/lab-3/alice. Sub-pads are listed in the sidebar.`),
        feature('sparkles', 'Live collaboration', 'See each other’s cursors and edits in real time. Edits never overwrite each other, even offline.'),
        feature('play', 'Run code', 'Python, C, C++, Java, JavaScript, Go, Rust and more, with input, live output and clickable errors.'),
        feature('terminal', 'Terminal', 'Run commands in the pad’s own workspace: compile with your own flags, create input files, list output.'),
        feature('history', 'Version history', 'Snapshots are kept automatically. Compare any version with now and restore it.'),
        feature('lock', 'Password locks', 'Make a pad read-only or private. The lock covers its sub-pads too.'),
        feature('folder', 'Multi-file projects', 'Attach util.h, helper.py or input.txt to a pad; they sit next to your program when it runs.'),
        feature('eye', 'Live preview', 'Markdown renders as you type; HTML, CSS and JavaScript run in a sandboxed preview.'),
        feature('link', 'Works with curl', `curl ${host}/name prints a pad; curl --data-binary @file ${host}/name saves one.`),
      ),
      h('footer.landing-footer', null, 'Anyone who knows a pad’s address can read and edit it unless it is locked. Don’t put secrets in open pads.'),
    ),
  );
  input.focus();
}
