import type { EditorState } from '@codemirror/state';
import * as Y from 'yjs';
import { baseName } from '../shared/padpath.js';
import { effectiveLanguage } from '../shared/langs.js';
import { PadProvider } from './collab';
import { settings } from './settings';
import { tokensFor } from './tokens';
import { Emitter } from './util';

/**
 * One open pad: its Yjs document, connection and editor state. The page's own pad and
 * each attached file (a sub-pad shown as a tab) are separate PadDocs.
 */
export class PadDoc extends Emitter<{ language: [string]; change: [] }> {
  readonly name: string;
  readonly provider: PadProvider;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly stdin: Y.Text;
  readonly meta: Y.Map<unknown>;
  readonly undo: Y.UndoManager;
  /** Editor state while another tab is showing. */
  state: EditorState | null = null;
  /** Synced with the server at least once (edits made offline after that are kept). */
  everSynced = false;
  #language: string;

  constructor(readonly path: string) {
    super();
    this.name = baseName(path);
    this.provider = new PadProvider(path, () => tokensFor(path));
    this.doc = this.provider.doc;
    this.text = this.doc.getText('content');
    this.stdin = this.doc.getText('stdin');
    this.meta = this.doc.getMap('meta');
    this.undo = new Y.UndoManager(this.text);
    this.#language = this.effective();
    this.setUser();

    let timer: ReturnType<typeof setTimeout> | undefined;
    this.text.observe(() => {
      this.emit('change');
      // Re-guess the language while the user types, if they did not pick one.
      if (this.chosen() !== 'auto') return;
      clearTimeout(timer);
      timer = setTimeout(() => this.#refreshLanguage(), 600);
    });
    this.meta.observe(() => this.#refreshLanguage());
    this.provider.on('synced', () => {
      this.everSynced = true;
      this.#refreshLanguage();
    });
  }

  setUser(): void {
    const { name, color } = settings.value;
    this.provider.awareness.setLocalStateField('user', { name, color, colorLight: color + '33' });
  }

  /** 'auto' or a language id chosen by someone on this pad. */
  chosen(): string {
    const v = this.meta.get('language');
    return typeof v === 'string' ? v : 'auto';
  }

  effective(): string {
    return effectiveLanguage(this.chosen(), this.name, this.text.toString());
  }

  get language(): string {
    return this.#language;
  }

  setLanguage(id: string): void {
    this.meta.set('language', id);
  }

  #refreshLanguage(): void {
    const next = this.effective();
    if (next === this.#language) return;
    this.#language = next;
    this.emit('language', next);
  }

  destroy(): void {
    this.undo.destroy();
    this.provider.destroy();
  }
}
