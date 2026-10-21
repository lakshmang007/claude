import { describeExit, type ExecClient, type JobHandle } from '../exec';
import { h, icon, storageGet, storageSet } from '../util';
import { confirmDialog } from './dialog';
import { ConsoleView } from './console';

/**
 * The Terminal tab: runs shell commands in the pad's workspace on the server. Not a full
 * terminal emulator: each command runs to completion with its output streamed here, and
 * while it runs the input line feeds its stdin.
 */
export class TerminalPanel {
  readonly el: HTMLElement;
  readonly console: ConsoleView;
  #input: HTMLInputElement;
  #prompt: HTMLElement;
  #job: JobHandle | null = null;
  #history: string[];
  #historyPos = -1;
  #draft = '';
  #greeted = false;

  constructor(
    private exec: ExecClient,
    private opts: {
      pad: string;
      tokens: () => string[];
      source: () => { language: string; code: string; mainFile: string };
      knownFile: (name: string) => boolean;
      onFileRef: (file: string, line: number, col?: number) => void;
      onNeedKey: () => Promise<boolean>;
      timeoutSeconds: () => number;
    },
  ) {
    this.console = new ConsoleView({ label: 'Terminal output', knownFile: opts.knownFile, onFileRef: opts.onFileRef });
    this.#history = storageGet<string[]>(this.#historyKey, []);
    this.#prompt = h('span.term-prompt', null, '$');
    this.#input = h('input.term-input', {
      type: 'text',
      'aria-label': 'Terminal command',
      placeholder: 'Type a command, e.g. ls or gcc main.c && ./a.out',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;
    this.#input.addEventListener('keydown', (e) => this.#onKey(e));
    const reset = h('button.btn.small', { type: 'button', title: 'Delete every file in this workspace' }, icon('trash', 13), 'Reset workspace');
    reset.addEventListener('click', () => this.#reset());
    const clear = h('button.btn.small', { type: 'button', title: 'Clear the screen (or type clear)' }, 'Clear');
    clear.addEventListener('click', () => this.console.clear());
    this.el = h(
      'div.terminal-panel',
      null,
      this.console.el,
      h('div.term-row', null, this.#prompt, this.#input, h('div.term-actions', null, clear, reset)),
    );
    this.console.el.addEventListener('click', () => {
      if (!window.getSelection()?.toString()) this.#input.focus();
    });
  }

  get #historyKey(): string {
    return `runpad.term.${this.opts.pad}`;
  }

  focus(): void {
    this.greet();
    this.#input.focus({ preventScroll: true });
  }

  greet(): void {
    if (this.#greeted) return;
    this.#greeted = true;
    const { mainFile } = this.opts.source();
    this.console.line(`Terminal for /${this.opts.pad} — commands run on the server in this pad's own workspace.`, 'system');
    this.console.line(`The pad is saved there as ${mainFile} (with its attached files) before each command. Type help for examples.`, 'system');
  }

  #help(): void {
    const { mainFile } = this.opts.source();
    const lines = [
      'Examples:',
      '  ls -la                          list the workspace',
      `  cat ${mainFile}`,
      '  gcc main.c -o app && ./app      compile and run C',
      '  g++ -std=c++17 main.cpp && ./a.out',
      '  javac Main.java && java Main',
      '  python3 main.py < input.txt     feed a file as input',
      '  echo "1 2 3" > input.txt',
      '',
      `Each command may run for ${this.opts.timeoutSeconds()} s and has no network access.`,
      'While a command runs, type here to send it input. Ctrl+C stops it, Ctrl+D ends its input.',
      '↑ / ↓ go through earlier commands. "clear" clears the screen.',
    ];
    this.console.line(lines.join('\n'), 'system');
  }

  #onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = this.#input.value;
      this.#input.value = '';
      if (this.#job) {
        this.console.echo(value + '\n');
        this.#job.stdin(value + '\n');
      } else {
        this.#runCommand(value);
      }
    } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && !window.getSelection()?.toString() && this.#input.selectionStart === this.#input.selectionEnd) {
      e.preventDefault();
      if (this.#job) {
        this.console.echo('^C\n');
        this.#job.kill();
      } else {
        this.#input.value = '';
      }
    } else if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      if (this.#job) {
        if (this.#input.value) this.#job.stdin(this.#input.value);
        this.#input.value = '';
        this.#job.eof();
      }
    } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      this.console.clear();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !this.#job) {
      e.preventDefault();
      if (!this.#history.length) return;
      if (this.#historyPos === -1) this.#draft = this.#input.value;
      const next = e.key === 'ArrowUp' ? Math.min(this.#history.length - 1, this.#historyPos + 1) : this.#historyPos - 1;
      this.#historyPos = next;
      this.#input.value = next < 0 ? this.#draft : this.#history[this.#history.length - 1 - next];
      if (next < 0) this.#historyPos = -1;
      requestAnimationFrame(() => this.#input.setSelectionRange(this.#input.value.length, this.#input.value.length));
    }
  }

  #remember(command: string): void {
    if (this.#history.at(-1) !== command) this.#history.push(command);
    if (this.#history.length > 200) this.#history = this.#history.slice(-200);
    storageSet(this.#historyKey, this.#history);
    this.#historyPos = -1;
    this.#draft = '';
  }

  #setBusy(busy: boolean): void {
    this.#prompt.textContent = busy ? '›' : '$';
    this.#input.placeholder = busy ? 'Running… type input and press Enter · Ctrl+C to stop' : 'Type a command, e.g. ls or gcc main.c && ./a.out';
    this.el.classList.toggle('busy', busy);
  }

  async #runCommand(raw: string): Promise<void> {
    const command = raw.trim();
    this.greet();
    if (!command) {
      this.console.line('$', 'command');
      return;
    }
    this.#remember(command);
    if (command === 'clear' || command === 'cls') return this.console.clear();
    this.console.line(`$ ${command}`, 'command');
    if (command === 'help' || command === '?') return this.#help();
    const src = this.opts.source();
    this.#setBusy(true);
    const done = () => {
      this.#job = null;
      this.#setBusy(false);
    };
    try {
      this.#job = await this.exec.start(
        { type: 'cmd', command, pad: this.opts.pad, language: src.language, code: src.code, tokens: this.opts.tokens() },
        {
          onOutput: (stream, data) => this.console.write(stream, data),
          onExit: (info) => {
            done();
            if (info.reason || info.signal) this.console.line(describeExit(info).text, 'fail');
            else if (info.code) this.console.line(`[exit code ${info.code}]`, 'fail');
          },
          onError: async (message, code) => {
            done();
            if (code === 'key' && (await this.opts.onNeedKey())) return this.#runCommand(raw);
            this.console.line(message, 'fail');
          },
        },
      );
    } catch (err) {
      done();
      this.console.line((err as Error).message, 'fail');
    }
  }

  async #reset(): Promise<void> {
    if (this.#job) return;
    const ok = await confirmDialog('Reset workspace?', 'This deletes every file in this pad’s terminal workspace on the server (your pad itself is not touched).', 'Reset', true);
    if (!ok) return;
    try {
      await this.exec.start(
        { type: 'reset', pad: this.opts.pad, tokens: this.opts.tokens() },
        {
          onExit: () => this.console.line('Workspace reset.', 'system'),
          onError: (message) => this.console.line(message, 'fail'),
        },
      );
    } catch (err) {
      this.console.line((err as Error).message, 'fail');
    }
  }
}
