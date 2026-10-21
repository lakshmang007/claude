import { ansiClasses, findFileRefs, isPlain, parseAnsi, plainState, type AnsiState } from '../ansi';
import { h } from '../util';

/**
 * Scrolling output log shared by the Output and Terminal panels. Streams keep their own
 * ANSI state so colours carry across chunks; `file:line` references in output become
 * links that jump to the editor.
 */

export type LineKind = 'stdout' | 'stderr' | 'system' | 'input' | 'ok' | 'fail' | 'command';

const MAX_CHARS = 2_000_000;

export class ConsoleView {
  readonly el: HTMLElement;
  #pre: HTMLElement;
  #states: Record<string, AnsiState> = { stdout: plainState(), stderr: plainState() };
  #lastKey = '';
  #lastText: Text | null = null;
  #chars = 0;

  constructor(
    private opts: {
      knownFile?: (name: string) => boolean;
      onFileRef?: (file: string, line: number, col?: number) => void;
      label: string;
    },
  ) {
    this.#pre = h('pre.console-pre', { role: 'log', 'aria-label': opts.label, 'aria-live': 'polite', tabindex: '0' });
    this.el = h('div.console', null, this.#pre);
  }

  get isEmpty(): boolean {
    return this.#chars === 0;
  }

  get text(): string {
    return this.#pre.textContent ?? '';
  }

  clear(): void {
    this.#pre.textContent = '';
    this.#states = { stdout: plainState(), stderr: plainState() };
    this.#lastKey = '';
    this.#lastText = null;
    this.#chars = 0;
  }

  #nearBottom(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 60;
  }

  #append(text: string, cls: string): void {
    if (!text) return;
    this.#chars += text.length;
    if (this.#chars > MAX_CHARS) this.#trim();
    if (this.#lastText && this.#lastKey === cls) {
      this.#lastText.appendData(text);
      return;
    }
    const node = document.createTextNode(text);
    if (cls) this.#pre.append(h('span', { class: cls }, node));
    else this.#pre.append(node);
    this.#lastText = node;
    this.#lastKey = cls;
  }

  #trim(): void {
    while (this.#pre.firstChild && this.#chars > MAX_CHARS / 2) {
      this.#chars -= this.#pre.firstChild.textContent?.length ?? 0;
      this.#pre.firstChild.remove();
    }
    this.#lastText = null;
    this.#lastKey = '';
  }

  #link(ref: { file: string; line: number; col?: number }, text: string, cls: string): void {
    const a = h('a.file-ref', { href: '#', class: cls || null, title: `Go to ${ref.file} line ${ref.line}` }, text);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      this.opts.onFileRef?.(ref.file, ref.line, ref.col);
    });
    this.#pre.append(a);
    this.#chars += text.length;
    this.#lastText = null;
    this.#lastKey = '';
  }

  /** Program output. */
  write(stream: 'stdout' | 'stderr', data: string): void {
    const stick = this.#nearBottom();
    for (const seg of parseAnsi(data, this.#states[stream])) {
      const cls = [stream === 'stderr' ? 'out-stderr' : '', isPlain(seg.state) ? '' : ansiClasses(seg.state)].filter(Boolean).join(' ');
      const refs = this.opts.knownFile ? findFileRefs(seg.text, this.opts.knownFile) : [];
      let pos = 0;
      for (const ref of refs) {
        this.#append(seg.text.slice(pos, ref.start), cls);
        this.#link(ref, seg.text.slice(ref.start, ref.end), cls);
        pos = ref.end;
      }
      this.#append(seg.text.slice(pos), cls);
    }
    if (stick) this.scrollToEnd();
  }

  /** A whole line of app text (status, the command being run, typed input). */
  line(text: string, kind: LineKind): void {
    const stick = this.#nearBottom();
    const last = this.#pre.textContent ?? '';
    if (last && !last.endsWith('\n') && kind !== 'input') this.#append('\n', '');
    this.#append(text + (text.endsWith('\n') ? '' : '\n'), `line-${kind}`);
    if (stick || kind === 'command') this.scrollToEnd();
  }

  /** Text the user typed into a running program, shown inline like a terminal echo. */
  echo(text: string): void {
    this.#append(text, 'line-input');
    this.scrollToEnd();
  }

  scrollToEnd(): void {
    this.el.scrollTop = this.el.scrollHeight;
  }
}
