import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { isDark, type Settings } from './settings';

/**
 * CodeMirror setup. Each open file has its own EditorState bound to its Y.Text; the app
 * swaps states in one EditorView when switching tabs. Settings and the language live in
 * compartments so they can change without rebuilding the state.
 */

const loaders: Record<string, () => Promise<Extension>> = {
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby').then((m) => StreamLanguage.define(m.ruby)),
  perl: () => import('@codemirror/legacy-modes/mode/perl').then((m) => StreamLanguage.define(m.perl)),
  lua: () => import('@codemirror/legacy-modes/mode/lua').then((m) => StreamLanguage.define(m.lua)),
  bash: () => import('@codemirror/legacy-modes/mode/shell').then((m) => StreamLanguage.define(m.shell)),
};

const cache = new Map<string, Promise<Extension>>();

export function loadLanguage(id: string): Promise<Extension> {
  const loader = loaders[id];
  if (!loader) return Promise.resolve([]);
  let p = cache.get(id);
  if (!p) {
    p = loader().catch(() => []);
    cache.set(id, p);
  }
  return p;
}

/**
 * Language support for the editor. Brackets and quotes close themselves only in code:
 * a plain-text pad behaves like a plain notepad, and before a new pad's language is
 * detected, auto-closing would not know about things like Python's f"" strings.
 */
export function languageSupport(id: string, ext: Extension): Extension {
  return id === 'plaintext' || id === 'markdown' ? ext : [ext, closeBrackets()];
}

export const compartments = {
  language: new Compartment(),
  theme: new Compartment(),
  wrap: new Compartment(),
  tabs: new Compartment(),
  gutter: new Compartment(),
  readOnly: new Compartment(),
};

const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
    '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
    '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
  },
  { dark: false },
);

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { padding: '10px 0 40vh' },
  '&.cm-focused': { outline: 'none' },
  '.cm-ySelectionInfo': { fontFamily: 'var(--sans)', fontSize: '11px', padding: '1px 4px', borderRadius: '3px', opacity: '1', top: '-1.35em' },
  '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'italic' },
});

export function themeExtension(s: Settings): Extension {
  return isDark(s) ? oneDark : [lightTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true })];
}

export function wrapExtension(s: Settings): Extension {
  return s.wrap ? EditorView.lineWrapping : [];
}

export function tabExtension(s: Settings): Extension {
  return [EditorState.tabSize.of(s.tabSize), indentUnit.of(' '.repeat(s.tabSize))];
}

export function gutterExtension(s: Settings): Extension {
  return s.lineNumbers ? [lineNumbers(), highlightActiveLineGutter(), foldGutter()] : [];
}

export function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/**
 * Builds the state for one file.
 * @param extraKeys app-wide shortcuts (Run etc.), which take precedence over the editor's
 */
export function createState(opts: {
  ytext: Y.Text;
  awareness: Awareness;
  undo: Y.UndoManager;
  settings: Settings;
  language: Extension;
  readOnly: boolean;
  extraKeys: Extension;
  placeholderText?: string;
}): EditorState {
  const { settings: s } = opts;
  return EditorState.create({
    doc: opts.ytext.toString(),
    extensions: [
      opts.extraKeys,
      compartments.gutter.of(gutterExtension(s)),
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      autocompletion({ activateOnTyping: true }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([...yUndoManagerKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      compartments.language.of(opts.language),
      compartments.theme.of(themeExtension(s)),
      compartments.wrap.of(wrapExtension(s)),
      compartments.tabs.of(tabExtension(s)),
      compartments.readOnly.of(readOnlyExtension(opts.readOnly)),
      baseTheme,
      placeholder(opts.placeholderText ?? ''),
      yCollab(opts.ytext, opts.awareness, { undoManager: opts.undo }),
    ],
  });
}

/** A small plain-text editor (the program input box), also bound to a Y.Text. */
export function createPlainState(opts: { ytext: Y.Text; awareness: Awareness; settings: Settings; readOnly: boolean; placeholderText: string; extraKeys: Extension }): EditorState {
  return EditorState.create({
    doc: opts.ytext.toString(),
    extensions: [
      opts.extraKeys,
      compartments.gutter.of(gutterExtension(opts.settings)),
      highlightSpecialChars(),
      drawSelection(),
      highlightActiveLine(),
      keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
      compartments.theme.of(themeExtension(opts.settings)),
      compartments.wrap.of(wrapExtension(opts.settings)),
      compartments.readOnly.of(readOnlyExtension(opts.readOnly)),
      baseTheme,
      EditorView.theme({ '.cm-content': { padding: '8px 0' } }),
      placeholder(opts.placeholderText),
      yCollab(opts.ytext, opts.awareness, { undoManager: new Y.UndoManager(opts.ytext) }),
    ],
  });
}

/** Applies the user's settings to a view's current state. */
export function reconfigure(view: EditorView, s: Settings, plain = false): void {
  view.dispatch({
    effects: [
      compartments.theme.reconfigure(themeExtension(s)),
      compartments.wrap.reconfigure(wrapExtension(s)),
      compartments.gutter.reconfigure(gutterExtension(s)),
      ...(plain ? [] : [compartments.tabs.reconfigure(tabExtension(s))]),
    ],
  });
}
