import { Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { isAttachableName, normalizePadPath, padUrl } from '../shared/padpath.js';
import { LANGUAGE_BY_ID, LANGUAGES, languageFromName, mainFileName } from '../shared/langs.js';
import { replaceText } from '../shared/ytext.js';
import { api, apiPath, type ChildPad, type PadInfo, type ServerConfig } from './api';
import { compartments, createPlainState, createState, languageSupport, loadLanguage, readOnlyExtension, reconfigure } from './editor';
import { ExecClient } from './exec';
import { PadDoc } from './pad';
import { rememberPad } from './recent';
import { settings } from './settings';
import { setRunKey, tokensFor } from './tokens';
import { copyText, h, icon, modKey, saveFile, storageGet, storageSet, toast } from './util';
import { confirmDialog, promptDialog } from './ui/dialog';
import { openHistory } from './ui/history';
import { openLockDialog, unlockForm } from './ui/lock';
import { openMenu } from './ui/menu';
import { openAbout, openCli, openSettings, openShortcuts } from './ui/misc';
import { OutputPanel } from './ui/output';
import { PreviewPane } from './ui/preview';
import { Sidebar } from './ui/sidebar';
import { TerminalPanel } from './ui/terminal';

type PanelTab = 'output' | 'input' | 'terminal';

const PANEL_KEY = 'runpad.panel';

/** The page for one pad: editor with tabs for attached files, run panel, terminal. */
export class PadApp {
  config: ServerConfig = { maxPadChars: 1 << 20, exec: { enabled: false, terminal: false, needsKey: false, languages: [] } };
  info: PadInfo | null = null;
  readonly exec = new ExecClient();
  readonly main: PadDoc;
  docs: PadDoc[] = [];
  active: PadDoc;
  attached: ChildPad[] = [];
  view!: EditorView;
  stdinView!: EditorView;
  output!: OutputPanel;
  terminal: TerminalPanel | null = null;
  sidebar!: Sidebar;
  preview!: PreviewPane;
  panelTab: PanelTab = 'output';
  panel = storageGet<{ height: number; open: boolean; sidebar: boolean | null }>(PANEL_KEY, { height: 260, open: false, sidebar: null });

  // DOM
  root!: HTMLElement;
  statusEl!: HTMLElement;
  peopleEl!: HTMLElement;
  lockBadge!: HTMLButtonElement;
  langSelect!: HTMLSelectElement;
  runBtn!: HTMLButtonElement;
  previewBtn!: HTMLButtonElement;
  tabbar!: HTMLElement;
  banner!: HTMLElement;
  editorArea!: HTMLElement;
  editorHost!: HTMLElement;
  emptyCard!: HTMLElement;
  panelEl!: HTMLElement;
  panelBody!: HTMLElement;
  panelTabs: Record<PanelTab, HTMLButtonElement> = {} as Record<PanelTab, HTMLButtonElement>;
  panelViews: Record<PanelTab, HTMLElement> = {} as Record<PanelTab, HTMLElement>;
  runStatusSlot!: HTMLElement;

  constructor(
    readonly path: string,
    private mount: HTMLElement,
  ) {
    this.main = new PadDoc(path);
    this.docs = [this.main];
    this.active = this.main;
  }

  async start(): Promise<void> {
    document.title = `/${this.path} · RunPad`;
    const [config, info] = await Promise.all([api.config().catch(() => this.config), api.pad(this.path).catch(() => null)]);
    this.config = config;
    this.info = info;
    if (info && !info.canRead) {
      this.main.destroy();
      this.renderLockedScreen(info);
      return;
    }
    rememberPad(this.path);
    this.render();
    this.bindDoc(this.main);
    this.showDoc(this.main);
    this.sidebar.refresh();
    this.updateLockUi();
    settings.on('change', () => this.applySettings());
    this.applySettings();
    window.addEventListener('keydown', (e) => this.onGlobalKey(e));
    window.addEventListener('online', () => this.docs.forEach((d) => d.provider.reconnect()));
    this.main.provider.awareness.on('change', () => this.renderPeople());
  }

  // ---- layout ---------------------------------------------------------------

  renderLockedScreen(info: PadInfo): void {
    const lockPath = info.lock?.path ?? this.path;
    this.mount.replaceChildren(
      h(
        'main.locked-screen',
        null,
        h(
          'div.locked-card',
          null,
          icon('lock', 36),
          h('h1', null, `/${this.path}`),
          h('p', null, lockPath === this.path ? 'This pad is private.' : `This pad is inside /${lockPath}, which is private.`),
          h('p.hint', null, 'Enter its password to open it on this browser.'),
          unlockForm(this.path, () => location.reload()),
          h('p', null, h('a', { href: '/' }, '← RunPad home')),
        ),
      ),
    );
  }

  render(): void {
    const crumbs = h('nav.crumbs', { 'aria-label': 'Pad path' });
    const parts = this.path.split('/');
    parts.forEach((part, i) => {
      crumbs.append(h('span.crumb-sep', null, '/'));
      const target = parts.slice(0, i + 1).join('/');
      crumbs.append(i === parts.length - 1 ? h('span.crumb.current', { 'aria-current': 'page' }, part) : h('a.crumb', { href: padUrl(target) }, part));
    });

    const sideToggle = h('button.icon-btn', { type: 'button', title: `Sub-pads and recent pads (${modKey}+B)`, 'aria-label': 'Toggle sidebar' }, icon('menu'));
    sideToggle.addEventListener('click', () => this.toggleSidebar());

    this.lockBadge = h('button.lock-badge', { type: 'button', hidden: true }) as HTMLButtonElement;
    this.lockBadge.addEventListener('click', () => this.openLock());
    this.statusEl = h('span.conn', { role: 'status' });
    this.peopleEl = h('div.people', { 'aria-label': 'People on this pad' });

    this.langSelect = h('select.lang-select', { 'aria-label': 'Language', title: 'Language for highlighting and running' }) as HTMLSelectElement;
    this.langSelect.addEventListener('change', () => {
      this.active.setLanguage(this.langSelect.value);
      this.view.focus();
    });

    this.runBtn = h('button.btn.run-btn', { type: 'button', title: `Run (${modKey}+Enter)` }, icon('play', 14), h('span', null, 'Run')) as HTMLButtonElement;
    this.runBtn.addEventListener('click', () => (this.output.running ? this.output.stop() : this.run()));

    this.previewBtn = h('button.btn.preview-btn', { type: 'button', hidden: true, title: 'Show a live preview' }, icon('eye', 14), h('span', null, 'Preview')) as HTMLButtonElement;
    this.previewBtn.addEventListener('click', () => this.togglePreview());

    const menuBtn = h('button.icon-btn', { type: 'button', title: 'More', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
    menuBtn.addEventListener('click', () => this.openMainMenu(menuBtn));

    const header = h(
      'header.topbar',
      null,
      sideToggle,
      h('a.brand', { href: '/', title: 'RunPad home' }, h('span.brand-mark', null, icon('play', 12)), h('span.brand-name', null, 'RunPad')),
      crumbs,
      this.lockBadge,
      h('span.spacer'),
      this.statusEl,
      this.peopleEl,
      this.langSelect,
      this.previewBtn,
      this.runBtn,
      menuBtn,
    );

    this.sidebar = new Sidebar({
      path: this.path,
      isAttachable: isAttachableName,
      onOpenFile: (child) => {
        if (this.isNarrow()) this.root.classList.remove('with-sidebar');
        this.openFile(child.path);
      },
      onChildren: (children) => this.updateAttached(children),
    });

    this.tabbar = h('div.tabbar', { role: 'tablist', 'aria-label': 'Files' });
    this.banner = h('div.banner', { hidden: true });
    this.editorHost = h('div.editor-host');
    this.emptyCard = this.renderEmptyCard();
    this.preview = new PreviewPane(() => this.togglePreview(false));
    this.preview.el.hidden = true;
    this.editorArea = h('div.editor-area', null, h('div.editor-wrap', null, this.editorHost, this.emptyCard), this.preview.el);

    this.renderPanel();
    const splitter = h('div.splitter', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize output panel', tabindex: '0' });
    this.bindSplitter(splitter);

    const work = h('section.work', null, this.tabbar, this.banner, this.editorArea, splitter, this.panelEl);
    // On a phone the sidebar covers the page, so it always starts closed there.
    this.root = h('div.app', { class: this.panel.sidebar && !this.isNarrow() ? 'with-sidebar' : null }, header, h('div.main', null, this.sidebar.el, work));
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (this.isNarrow() && this.root.classList.contains('with-sidebar') && !this.sidebar.el.contains(target) && !sideToggle.contains(target)) {
        this.root.classList.remove('with-sidebar');
      }
    });
    this.mount.replaceChildren(this.root);

    this.view = new EditorView({ parent: this.editorHost });
    this.renderLanguageOptions();
    this.renderTabs();
    this.setPanelOpen(this.panel.open);
    this.updateStatus();
  }

  renderEmptyCard(): HTMLElement {
    const runnable = new Set(this.config.exec.languages.map((l) => l.id));
    const choices = LANGUAGES.filter((l) => l.template && (runnable.has(l.id) || l.id === 'html'));
    const buttons = choices.map((l) => {
      const b = h('button.chip', { type: 'button' }, l.name.replace(' (Node.js)', ''));
      b.addEventListener('click', () => this.insertTemplate(l.id));
      return b;
    });
    return h(
      'div.empty-card',
      { hidden: true },
      h('h2', null, 'This pad is empty'),
      h('p', null, 'Start typing: everything is saved automatically and shared with anyone who opens this address.'),
      buttons.length ? h('p.hint', null, 'Or start from a small program:') : null,
      h('div.chips', null, ...buttons),
    );
  }

  async insertTemplate(id: string): Promise<void> {
    const lang = LANGUAGE_BY_ID.get(id);
    if (!lang?.template || !this.canEdit(this.main)) return;
    if (this.main.text.length) await this.keepInHistory(this.main);
    this.main.doc.transact(() => {
      replaceText(this.main.text, lang.template!);
      if (languageFromName(this.main.name) !== id) this.main.meta.set('language', id);
    });
    this.view.focus();
  }

  renderPanel(): void {
    const tab = (id: PanelTab, label: string, iconName: string) => {
      const b = h('button.panel-tab', { type: 'button', role: 'tab', 'aria-selected': 'false', 'aria-label': label, title: label, id: `ptab-${id}` }, icon(iconName, 14), h('span', null, label)) as HTMLButtonElement;
      b.addEventListener('click', () => {
        if (this.panelTab === id && this.panel.open) this.setPanelOpen(false);
        else this.showPanelTab(id);
      });
      this.panelTabs[id] = b;
      return b;
    };
    const knownFile = (name: string) => this.fileForName(name) !== null;
    const onFileRef = (file: string, line: number, col?: number) => this.gotoFileLine(file, line, col);
    const onNeedKey = () => this.askRunKey();

    this.output = new OutputPanel(this.exec, { knownFile, onFileRef, onNeedKey, limits: () => this.config.exec.limits });
    this.output.onRunningChange = (running) => {
      this.runBtn.classList.toggle('running', running);
      this.runBtn.replaceChildren(icon(running ? 'stop' : 'play', 14), h('span', null, running ? 'Stop' : 'Run'));
      this.runBtn.title = running ? `Stop (${modKey}+Shift+Enter)` : `Run (${modKey}+Enter)`;
    };

    const stdinHost = h('div.stdin-editor');
    const inputView = h(
      'div.input-panel',
      null,
      h('p.panel-hint', null, 'Text here is given to the program as its input, followed by end of file. Leave it empty to type input while the program runs. It is saved with the pad and shared.'),
      stdinHost,
    );
    this.stdinView = new EditorView({ parent: stdinHost });

    const termView = h('div.terminal-host');
    this.panelViews = { output: this.output.el, input: inputView, terminal: termView };

    const clear = h('button.icon-btn.small', { type: 'button', title: 'Clear output', 'aria-label': 'Clear output' }, icon('trash', 14));
    clear.addEventListener('click', () => (this.panelTab === 'terminal' ? this.terminal?.console.clear() : this.output.clear()));
    const copy = h('button.icon-btn.small', { type: 'button', title: 'Copy output', 'aria-label': 'Copy output' }, icon('copy', 14));
    copy.addEventListener('click', async () => {
      const text = this.panelTab === 'terminal' ? (this.terminal?.console.text ?? '') : this.output.console.text;
      toast((await copyText(text)) ? 'Output copied' : 'Could not copy', 'success', 1500);
    });
    const max = h('button.icon-btn.small', { type: 'button', title: 'Maximise panel', 'aria-label': 'Maximise panel' }, icon('maximize', 14));
    max.addEventListener('click', () => this.root.classList.toggle('panel-max'));
    const collapse = h('button.icon-btn.small.collapse-btn', { type: 'button', title: `Hide panel (${modKey}+J)`, 'aria-label': 'Hide or show panel' }, icon('chevronDown', 14));
    collapse.addEventListener('click', () => this.setPanelOpen(!this.panel.open));
    this.runStatusSlot = h('div.panel-status', null, this.output.status);

    this.panelBody = h('div.panel-body', null, this.output.el, inputView, termView);
    this.panelEl = h(
      'section.panel',
      { 'aria-label': 'Output, input and terminal' },
      h('div.panel-head', null, h('div.panel-tabs', { role: 'tablist' }, tab('output', 'Output', 'play'), tab('input', 'Input', 'keyboard'), tab('terminal', 'Terminal', 'terminal')), this.runStatusSlot, h('div.panel-actions', null, copy, clear, max, collapse)),
      this.panelBody,
    );
    this.showPanelTab('output', false);
  }

  showPanelTab(id: PanelTab, open = true): void {
    this.panelTab = id;
    this.runStatusSlot.hidden = id !== 'output';
    for (const [key, el] of Object.entries(this.panelViews)) el.hidden = key !== id;
    for (const [key, b] of Object.entries(this.panelTabs)) b.setAttribute('aria-selected', String(key === id));
    if (open) this.setPanelOpen(true);
    if (id === 'terminal') this.ensureTerminal()?.focus();
    if (id === 'input') requestAnimationFrame(() => this.stdinView.focus());
  }

  setPanelOpen(open: boolean): void {
    this.panel.open = open;
    this.root?.classList.toggle('panel-open', open);
    if (!open) this.root?.classList.remove('panel-max');
    this.panelEl.style.setProperty('--panel-h', `${this.panel.height}px`);
    this.savePanel();
  }

  savePanel(): void {
    storageSet(PANEL_KEY, this.panel);
  }

  bindSplitter(splitter: HTMLElement): void {
    let startY = 0;
    let startH = 0;
    const move = (e: PointerEvent) => {
      const max = window.innerHeight - 160;
      this.panel.height = Math.round(Math.max(120, Math.min(max, startH + (startY - e.clientY))));
      this.panelEl.style.setProperty('--panel-h', `${this.panel.height}px`);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      this.root.classList.remove('resizing');
      this.savePanel();
    };
    splitter.addEventListener('pointerdown', (e) => {
      if (!this.panel.open) this.setPanelOpen(true);
      startY = e.clientY;
      startH = this.panel.height;
      this.root.classList.add('resizing');
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      e.preventDefault();
    });
    splitter.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      if (!this.panel.open) this.setPanelOpen(true);
      this.panel.height = Math.max(120, Math.min(window.innerHeight - 160, this.panel.height + (e.key === 'ArrowUp' ? 24 : -24)));
      this.panelEl.style.setProperty('--panel-h', `${this.panel.height}px`);
      this.savePanel();
    });
  }

  isNarrow(): boolean {
    return window.innerWidth <= 760;
  }

  toggleSidebar(force?: boolean): void {
    this.panel.sidebar = force ?? !this.root.classList.contains('with-sidebar');
    this.root.classList.toggle('with-sidebar', this.panel.sidebar);
    if (this.panel.sidebar) this.sidebar.refresh();
    this.savePanel();
  }

  ensureTerminal(): TerminalPanel | null {
    if (this.terminal) return this.terminal;
    const host = this.panelViews.terminal;
    if (!this.config.exec.enabled || !this.config.exec.terminal) {
      host.replaceChildren(h('div.console-empty', null, h('p', null, 'The terminal is turned off on this server.')));
      return null;
    }
    this.terminal = new TerminalPanel(this.exec, {
      pad: this.path,
      tokens: () => tokensFor(this.path),
      source: () => ({ language: this.main.language, code: this.main.text.toString(), mainFile: this.mainFile() }),
      knownFile: (name) => this.fileForName(name) !== null,
      onFileRef: (file, line, col) => this.gotoFileLine(file, line, col),
      onNeedKey: () => this.askRunKey(),
      timeoutSeconds: () => this.config.exec.limits?.interactiveSeconds ?? 300,
    });
    host.replaceChildren(this.terminal.el);
    return this.terminal;
  }

  // ---- documents and tabs -----------------------------------------------------

  mainFile(): string {
    return mainFileName(this.main.name, this.main.language, this.main.text.toString());
  }

  /** The open document a compiler message's file name refers to. */
  fileForName(name: string): PadDoc | string | null {
    if (name === this.mainFile()) return this.main;
    const child = this.attached.find((c) => c.name === name);
    if (!child) return null;
    return this.docs.find((d) => d.path === child.path) ?? child.path;
  }

  bindDoc(doc: PadDoc): void {
    const refreshState = () => {
      if (doc === this.active) {
        this.updateReadOnly();
        this.updateEmptyCard();
      }
      if (doc === this.main) this.updateStatus();
    };
    doc.provider.on('status', refreshState);
    doc.provider.on('synced', refreshState);
    doc.provider.on('perm', ({ canWrite }) => {
      refreshState();
      if (doc === this.main) {
        this.refreshInfo();
        if (!canWrite && doc.everSynced) this.updateLockUi();
      }
    });
    doc.provider.on('notice', ({ level, message }) => toast(message, level === 'error' ? 'error' : 'warn', 5000));
    doc.on('language', (lang) => {
      if (doc === this.active) this.applyLanguage(lang);
    });
    doc.on('change', () => {
      if (doc === this.active) this.updateEmptyCard();
    });
  }

  canEdit(doc: PadDoc): boolean {
    return doc.everSynced && doc.provider.canWrite;
  }

  editorKeys() {
    return Prec.highest(
      keymap.of([
        { key: 'Mod-Enter', run: () => (this.run(), true) },
        { key: 'Mod-Shift-Enter', run: () => (this.output.stop(), true) },
        { key: 'Mod-s', run: () => (toast('Pads save automatically as you type', 'success', 1800), true) },
      ]),
    );
  }

  stateFor(doc: PadDoc) {
    return createState({
      ytext: doc.text,
      awareness: doc.provider.awareness,
      undo: doc.undo,
      settings: settings.value,
      language: [],
      readOnly: !this.canEdit(doc),
      extraKeys: this.editorKeys(),
    });
  }

  showDoc(doc: PadDoc): void {
    if (this.view.state && this.active !== doc) this.active.state = this.view.state;
    this.active = doc;
    this.view.setState(doc.state ?? this.stateFor(doc));
    doc.state = null;
    this.applySettings();
    this.applyLanguage(doc.language);
    this.updateReadOnly();
    this.updateEmptyCard();
    this.renderTabs();
    if (doc === this.main) {
      this.stdinView.setState(
        createPlainState({ ytext: doc.stdin, awareness: doc.provider.awareness, settings: settings.value, readOnly: !this.canEdit(doc), placeholderText: 'e.g.\n5\n1 2 3 4 5', extraKeys: this.editorKeys() }),
      );
    }
  }

  openFile(path: string): void {
    let doc = this.docs.find((d) => d.path === path);
    if (!doc) {
      doc = new PadDoc(path);
      this.docs.push(doc);
      this.bindDoc(doc);
    }
    this.showDoc(doc);
    this.view.focus();
  }

  updateAttached(children: ChildPad[]): void {
    this.attached = children.filter((c) => c.exists && isAttachableName(c.name));
    // Until the user picks, the sidebar opens by itself on wide screens when there are sub-pads.
    if (this.panel.sidebar === null && children.length && window.innerWidth > 1000 && !this.root.classList.contains('with-sidebar')) this.root.classList.add('with-sidebar');
    this.renderTabs();
  }

  renderTabs(): void {
    const tabs: HTMLElement[] = [];
    const entries: Array<{ path: string; name: string; main: boolean }> = [
      { path: this.main.path, name: this.main.name, main: true },
      ...this.attached.map((c) => ({ path: c.path, name: c.name, main: false })),
      ...this.docs.filter((d) => d !== this.main && !this.attached.some((c) => c.path === d.path)).map((d) => ({ path: d.path, name: d.name, main: false })),
    ];
    for (const entry of entries) {
      const selected = this.active.path === entry.path;
      const btn = h('button.tab', { type: 'button', role: 'tab', 'aria-selected': String(selected), title: entry.main ? `/${entry.path}` : `Attached file /${entry.path}` }, icon('file', 13), h('span', null, entry.name));
      btn.addEventListener('click', () => (entry.main ? this.showDoc(this.main) : this.openFile(entry.path)));
      const wrap = h('div.tab-wrap', { class: selected ? 'selected' : null }, btn);
      if (!entry.main && this.info?.canWrite) {
        const close = h('button.tab-close', { type: 'button', title: `Delete ${entry.name}`, 'aria-label': `Delete ${entry.name}` }, icon('x', 12));
        close.addEventListener('click', () => this.deleteFile(entry.path, entry.name));
        wrap.append(close);
      }
      tabs.push(wrap);
    }
    const add = h('button.tab-add', { type: 'button', title: 'Add a file to this pad', 'aria-label': 'Add file', 'aria-haspopup': 'menu' }, icon('plus', 14));
    add.addEventListener('click', () =>
      openMenu(add, [
        { label: 'New file…', icon: 'file', action: () => this.newFile() },
        { label: 'Upload file…', icon: 'upload', action: () => this.uploadFile(true) },
      ]),
    );
    if (this.info?.canWrite !== false) tabs.push(add);
    this.tabbar.replaceChildren(...tabs);
    this.tabbar.classList.toggle('single', entries.length === 1);
  }

  async newFile(): Promise<void> {
    const name = await promptDialog('New file', 'File name', {
      placeholder: 'util.h, input.txt, helper.py…',
      okLabel: 'Create',
      hint: 'Files are sub-pads of this pad. They are copied next to your program when it runs, so it can #include, import or open them.',
    });
    if (!name) return;
    const clean = name.trim();
    const target = normalizePadPath(`${this.path}/${clean}`, { decoded: true });
    if (!target || !isAttachableName(clean)) {
      toast('Use a file name with an extension, like util.h or data.txt', 'error');
      return;
    }
    try {
      await api.touch(target);
      await this.sidebar.refresh();
      this.openFile(target);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async deleteFile(path: string, name: string): Promise<void> {
    if (!(await confirmDialog(`Delete ${name}?`, `This removes /${path} and its history.`, 'Delete', true))) return;
    try {
      await api.remove(path);
      const doc = this.docs.find((d) => d.path === path);
      if (doc) {
        if (this.active === doc) this.showDoc(this.main);
        this.docs = this.docs.filter((d) => d !== doc);
        doc.destroy();
      }
      await this.sidebar.refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  uploadFile(asAttachment: boolean): void {
    const input = h('input', { type: 'file' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > this.config.maxPadChars * 2) return toast('That file is too large for a pad', 'error');
      const text = await file.text();
      if (asAttachment) {
        const target = normalizePadPath(`${this.path}/${file.name}`, { decoded: true });
        if (!target || !isAttachableName(file.name)) return toast('That file name cannot be used for an attached file', 'error');
        const existing = this.attached.some((c) => c.path === target);
        if (existing && !(await confirmDialog(`Replace ${file.name}?`, 'A file with that name is already attached.', 'Replace'))) return;
        try {
          await api.touch(target);
          await this.sidebar.refresh();
          this.openFile(target);
          this.replaceWhenReady(this.active, text, file.name);
        } catch (err) {
          toast((err as Error).message, 'error');
        }
        return;
      }
      if (this.active.text.length && !(await confirmDialog('Replace the text?', `Replace the contents of ${this.active.name} with ${file.name}? The current text stays in history.`, 'Replace'))) return;
      this.replaceWhenReady(this.active, text, file.name);
    });
    input.click();
  }

  /** Makes sure the current text is in history before it is replaced wholesale. */
  async keepInHistory(doc: PadDoc): Promise<void> {
    try {
      await api.snapshot(doc.path);
    } catch {
      /* the replacement still goes ahead; history is best effort */
    }
  }

  replaceWhenReady(doc: PadDoc, text: string, fileName: string): void {
    const apply = async () => {
      if (!this.canEdit(doc)) return toast('This pad is locked', 'error');
      if (doc.text.length) await this.keepInHistory(doc);
      doc.doc.transact(() => {
        replaceText(doc.text, text);
        const lang = languageFromName(fileName);
        if (lang && languageFromName(doc.name) !== lang) doc.meta.set('language', lang);
      });
      toast(`Loaded ${fileName}`, 'success');
    };
    if (doc.provider.synced) apply();
    else {
      const off = doc.provider.on('synced', () => {
        off();
        apply();
      });
    }
  }

  async gotoFileLine(file: string, line: number, col?: number): Promise<void> {
    const target = this.fileForName(file);
    if (!target) return;
    if (typeof target === 'string') this.openFile(target);
    else if (target !== this.active) this.showDoc(target);
    const doc = this.view.state.doc;
    const ln = doc.line(Math.max(1, Math.min(doc.lines, line)));
    const pos = Math.min(ln.to, ln.from + Math.max(0, (col ?? 1) - 1));
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.view.focus();
  }

  // ---- state shown in the UI --------------------------------------------------

  applySettings(): void {
    const s = settings.value;
    document.documentElement.style.setProperty('--editor-font-size', `${s.fontSize}px`);
    reconfigure(this.view, s);
    reconfigure(this.stdinView, s, true);
    for (const doc of this.docs) doc.setUser();
  }

  async applyLanguage(lang: string): Promise<void> {
    this.renderLanguageOptions();
    this.updateRunButton();
    this.updatePreviewButton();
    const ext = await loadLanguage(lang);
    if (this.active.language !== lang) return;
    this.view.dispatch({ effects: compartments.language.reconfigure(languageSupport(lang, ext)) });
  }

  renderLanguageOptions(): void {
    const runnable = new Map(this.config.exec.languages.map((l) => [l.id, l]));
    const chosen = this.active.chosen();
    const detected = LANGUAGE_BY_ID.get(this.active.effective())?.name ?? 'Plain text';
    const sel = this.langSelect;
    sel.replaceChildren();
    sel.append(h('option', { value: 'auto' }, `Auto (${detected})`));
    const runGroup = h('optgroup', { label: 'Run on this server' });
    const otherGroup = h('optgroup', { label: runnable.size ? 'Highlighting only' : 'Languages' });
    for (const l of LANGUAGES) (runnable.has(l.id) ? runGroup : otherGroup).append(h('option', { value: l.id }, l.name));
    if (runGroup.children.length) sel.append(runGroup);
    sel.append(otherGroup);
    sel.value = LANGUAGE_BY_ID.has(chosen) ? chosen : 'auto';
    sel.disabled = !this.canEdit(this.active);
  }

  /** What Run runs: the pad itself, or the open file if the pad is not a program. */
  runTarget(): PadDoc | null {
    const runnable = new Set(this.config.exec.languages.map((l) => l.id));
    if (runnable.has(this.main.language)) return this.main;
    if (runnable.has(this.active.language)) return this.active;
    return null;
  }

  updateRunButton(): void {
    const target = this.runTarget();
    const exec = this.config.exec;
    let why = '';
    if (!exec.enabled) why = 'Running code is turned off on this server';
    else if (!target) {
      const name = LANGUAGE_BY_ID.get(this.active.language)?.name ?? this.active.language;
      why = ['plaintext', 'markdown'].includes(this.active.language) ? 'Pick a programming language to run this pad' : `${name} cannot be run on this server`;
    }
    this.runBtn.disabled = !!why && !this.output?.running;
    this.runBtn.title = why || `Run ${target ? (target === this.main ? this.mainFile() : target.name) : ''} (${modKey}+Enter)`;
    this.runBtn.hidden = this.active.language === 'html' && !target;
  }

  updatePreviewButton(): void {
    const lang = this.active.language;
    const can = lang === 'markdown' || lang === 'html';
    this.previewBtn.hidden = !can;
    const wanted = can && storageGet(`runpad.preview.${lang}`, lang === 'markdown' || lang === 'html');
    if (wanted && can) {
      this.preview.el.hidden = false;
      this.editorArea.classList.add('with-preview');
      this.preview.show(this.active, lang);
    } else {
      this.preview.hide();
      this.preview.el.hidden = true;
      this.editorArea.classList.remove('with-preview');
    }
    this.previewBtn.setAttribute('aria-pressed', String(!this.preview.el.hidden));
  }

  togglePreview(force?: boolean): void {
    const lang = this.active.language;
    const next = force ?? this.preview.el.hidden;
    storageSet(`runpad.preview.${lang}`, next);
    this.updatePreviewButton();
  }

  updateReadOnly(): void {
    const ro = !this.canEdit(this.active);
    this.view.dispatch({ effects: compartments.readOnly.reconfigure(readOnlyExtension(ro)) });
    if (this.active === this.main) this.stdinView.dispatch({ effects: compartments.readOnly.reconfigure(readOnlyExtension(ro)) });
    this.langSelect.disabled = ro;
    this.updateBanner();
  }

  updateEmptyCard(): void {
    const show = this.active === this.main && this.canEdit(this.main) && this.main.text.length === 0;
    this.emptyCard.hidden = !show;
  }

  updateStatus(): void {
    const p = this.main.provider;
    const map = {
      connecting: ['connecting', 'Connecting…'],
      online: p.synced ? ['online', 'Live'] : ['connecting', 'Syncing…'],
      offline: ['offline', 'Offline'],
      locked: ['offline', 'Locked'],
    } as const;
    const [cls, text] = map[p.status];
    this.statusEl.className = `conn ${cls}`;
    this.statusEl.title =
      p.status === 'offline' ? 'Not connected. Your edits are kept in this tab and saved when the connection returns.' : p.status === 'online' ? 'Connected: changes are saved and shared as you type' : '';
    this.statusEl.replaceChildren(h('span.dot'), h('span.conn-text', null, text));
    this.updateBanner();
  }

  updateBanner(): void {
    const p = this.active.provider;
    const items: Array<Node | string> = [];
    let kind = '';
    if (p.status === 'locked') {
      kind = 'warn';
      items.push(icon('lock', 14), 'This pad was made private. ', this.actionLink('Unlock', () => this.openLock()));
    } else if (p.status === 'offline' && this.active.everSynced) {
      kind = 'warn';
      items.push('Offline: your edits are kept in this tab and will be saved when the connection returns. ', this.actionLink('Retry now', () => this.docs.forEach((d) => d.provider.reconnect())));
    } else if (p.synced && !p.canWrite) {
      kind = 'info';
      const lock = p.lock;
      items.push(icon('lock', 14), lock && lock.path !== this.active.path ? `Read-only: /${lock.path} is locked. ` : 'Read-only: this pad is locked. You can still read and run it. ', this.actionLink('Unlock to edit', () => this.openLock()));
    }
    this.banner.hidden = !items.length;
    this.banner.className = `banner ${kind}`;
    this.banner.replaceChildren(...items);
  }

  actionLink(label: string, fn: () => void): HTMLElement {
    const b = h('button.link-btn', { type: 'button' }, label);
    b.addEventListener('click', fn);
    return b;
  }

  renderPeople(): void {
    const states = [...this.main.provider.awareness.getStates().entries()];
    const self = this.main.doc.clientID;
    const others = states.filter(([id, s]) => id !== self && s && (s as { user?: unknown }).user).map(([, s]) => (s as { user: { name: string; color: string } }).user);
    const shown = others.slice(0, 4);
    this.peopleEl.replaceChildren(
      ...shown.map((u) =>
        h('span.avatar', { style: `background:${u.color}`, title: u.name }, u.name
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase()),
      ),
      others.length > shown.length ? h('span.avatar.more', null, `+${others.length - shown.length}`) : '',
    );
    this.peopleEl.title = others.length ? `Also here: ${others.map((u) => u.name).join(', ')}` : 'Only you are here';
    this.peopleEl.hidden = !others.length;
  }

  async refreshInfo(): Promise<void> {
    try {
      this.info = await api.pad(this.path);
      this.updateLockUi();
      this.renderTabs();
    } catch {
      /* keep the last known state */
    }
  }

  updateLockUi(): void {
    const lock = this.info?.lock ?? this.main.provider.lock;
    this.lockBadge.hidden = !lock;
    if (lock) {
      const unlocked = this.info?.canWrite ?? this.main.provider.canWrite;
      this.lockBadge.replaceChildren(icon(unlocked ? 'unlock' : 'lock', 13), h('span', null, lock.mode === 'private' ? 'Private' : 'Read-only'));
      this.lockBadge.title = unlocked ? 'Locked; unlocked on this browser. Click to manage.' : 'Locked. Click to unlock.';
      this.lockBadge.classList.toggle('unlocked', unlocked);
    }
  }

  async openLock(): Promise<void> {
    try {
      this.info = await api.pad(this.path);
    } catch (err) {
      return toast((err as Error).message, 'error');
    }
    openLockDialog(this.path, this.info, () => this.afterAuthChange());
  }

  async afterAuthChange(): Promise<void> {
    for (const doc of this.docs) doc.provider.reauth();
    await this.refreshInfo();
    this.sidebar.refresh();
  }

  async askRunKey(): Promise<boolean> {
    const key = await promptDialog('Run key needed', 'Run key', {
      type: 'password',
      okLabel: 'Save and run',
      hint: 'This server only runs code for people with its run key. Ask whoever runs it. The key is remembered on this browser.',
    });
    if (key === null) return false;
    setRunKey(key);
    return true;
  }

  // ---- actions ------------------------------------------------------------------

  run(): void {
    if (this.output.running) return;
    const target = this.runTarget();
    if (!target) {
      toast(this.runBtn.title || 'Nothing to run', 'warn');
      return;
    }
    this.showPanelTab('output');
    this.output.run({
      language: target.language,
      languageName: LANGUAGE_BY_ID.get(target.language)?.name ?? target.language,
      code: target.text.toString(),
      stdin: this.main.stdin.toString(),
      pad: target.path,
      tokens: tokensFor(target.path),
    });
  }

  onGlobalKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.run();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      this.output.stop();
    } else if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      this.setPanelOpen(!this.panel.open);
    } else if (e.key === '`') {
      e.preventDefault();
      this.showPanelTab('terminal');
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      this.toggleSidebar();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      toast('Pads save automatically as you type', 'success', 1800);
    }
  }

  openMainMenu(anchor: HTMLElement): void {
    const doc = this.active;
    const lang = LANGUAGE_BY_ID.get(doc.language);
    const fileName = mainFileName(doc.name, doc.language, doc.text.toString()).replace(/^main\./, `${doc.name}.`);
    openMenu(anchor, [
      { label: 'New pad', icon: 'plus', action: () => this.newPad() },
      { label: 'Version history…', icon: 'history', action: () => openHistory({ path: doc.path, current: () => doc.text.toString(), canWrite: this.canEdit(doc) }) },
      { label: this.info?.lock ? 'Lock settings…' : 'Lock with password…', icon: 'lock', action: () => this.openLock() },
      'separator',
      { label: `Download ${fileName}`, icon: 'download', action: () => saveFile(fileName, doc.text.toString()) },
      { label: 'Download pad and sub-pads (.zip)', icon: 'zip', action: () => (location.href = apiPath('zip', this.path)) },
      { label: `Upload into ${doc.name}…`, icon: 'upload', disabled: !this.canEdit(doc), action: () => this.uploadFile(false) },
      'separator',
      {
        label: 'Copy link',
        icon: 'link',
        action: async () => toast((await copyText(location.origin + padUrl(this.path))) ? 'Link copied' : 'Could not copy', 'success', 1500),
      },
      { label: 'Use from the command line…', icon: 'terminal', action: () => openCli(doc.path) },
      ...(lang?.template && this.canEdit(this.main)
        ? [{ label: `Insert ${lang.name} starter program`, icon: 'wand', action: () => this.confirmTemplate(lang.id) }]
        : []),
      'separator',
      { label: 'Settings…', icon: 'settings', action: () => openSettings() },
      { label: 'Keyboard shortcuts', icon: 'keyboard', action: () => openShortcuts() },
      { label: 'About RunPad', icon: 'info', action: () => openAbout(this.exec.info ?? this.config.exec) },
    ]);
  }

  async confirmTemplate(id: string): Promise<void> {
    if (this.main.text.length && !(await confirmDialog('Replace the pad?', 'The starter program replaces the current text. The current text stays in history.', 'Replace'))) return;
    this.insertTemplate(id);
  }

  newPad(): void {
    const words = ['maple', 'river', 'comet', 'pixel', 'cedar', 'lunar', 'amber', 'delta', 'ember', 'orbit', 'quartz', 'tulip', 'zephyr', 'nova', 'atlas'];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    location.href = padUrl(`${pick()}-${pick()}-${Math.floor(100 + Math.random() * 900)}`);
  }
}

/** Opens the pad page for `path`. */
export async function startPad(path: string, mount: HTMLElement): Promise<PadApp> {
  const app = new PadApp(path, mount);
  await app.start();
  // Exposed for debugging and the end-to-end tests.
  (window as unknown as { runpad: PadApp }).runpad = app;
  return app;
}
