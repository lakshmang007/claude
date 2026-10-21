import type { ServerConfig } from '../api';
import { describeExit, type ExecClient, type JobHandle } from '../exec';
import { h, icon, modKey } from '../util';
import { ConsoleView } from './console';

/**
 * The Output tab: shows a run's compile and program output, and while an interactive
 * program runs, an input line that sends what the user types to its stdin.
 */
export class OutputPanel {
  readonly el: HTMLElement;
  readonly console: ConsoleView;
  readonly status: HTMLElement;
  #inputRow: HTMLElement;
  #input: HTMLInputElement;
  #job: JobHandle | null = null;
  #running = false;
  #emptyEl: HTMLElement;
  onRunningChange: (running: boolean) => void = () => {};

  constructor(
    private exec: ExecClient,
    private opts: {
      knownFile: (name: string) => boolean;
      onFileRef: (file: string, line: number, col?: number) => void;
      limits: () => ServerConfig['exec']['limits'];
      onNeedKey: () => Promise<boolean>;
    },
  ) {
    this.console = new ConsoleView({ label: 'Program output', knownFile: opts.knownFile, onFileRef: opts.onFileRef });
    this.status = h('span.run-status');
    this.#input = h('input.stdin-input', {
      type: 'text',
      placeholder: 'Type input for the program and press Enter',
      'aria-label': 'Program input',
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;
    const eofBtn = h('button.btn.small', { type: 'button', title: 'Close the input (Ctrl+D): for programs that read until end of file' }, 'End input');
    eofBtn.addEventListener('click', () => this.#eof());
    this.#inputRow = h('div.stdin-row', { hidden: true }, h('span.stdin-prompt', null, '›'), this.#input, eofBtn);
    this.#input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.#send(this.#input.value + '\n');
        this.#input.value = '';
      } else if ((e.key === 'd' || e.key === 'D') && e.ctrlKey) {
        e.preventDefault();
        if (this.#input.value) this.#send(this.#input.value);
        this.#input.value = '';
        this.#eof();
      } else if ((e.key === 'c' || e.key === 'C') && e.ctrlKey && !this.#input.selectionEnd) {
        e.preventDefault();
        this.stop();
      }
    });
    const empty = h('div.console-empty', null, h('p', null, 'Press ', h('kbd', null, 'Run'), ` (${modKey}+Enter) to run the program. Output appears here.`), h('p', null, 'Leave the Input tab empty to type input while the program runs.'));
    this.el = h('div.output-panel', null, empty, this.console.el, this.#inputRow);
    this.console.el.hidden = true;
    this.#emptyEl = empty;
  }

  get running(): boolean {
    return this.#running;
  }

  #send(text: string): void {
    if (!this.#job) return;
    this.console.echo(text);
    this.#job.stdin(text);
  }

  #eof(): void {
    if (!this.#job) return;
    this.#job.eof();
    this.console.line('[end of input]', 'system');
    this.#inputRow.hidden = true;
  }

  #setRunning(running: boolean): void {
    this.#running = running;
    this.onRunningChange(running);
    if (!running) {
      this.#inputRow.hidden = true;
      this.#job = null;
    }
  }

  clear(): void {
    this.console.clear();
    this.status.textContent = '';
    this.status.className = 'run-status';
  }

  stop(): void {
    this.#job?.kill();
  }

  /** Runs a program; output streams into the console. */
  async run(msg: { language: string; languageName: string; code: string; stdin: string; pad: string; tokens: string[] }): Promise<void> {
    if (this.#running) return;
    this.#emptyEl.hidden = true;
    this.console.el.hidden = false;
    this.console.clear();
    this.status.className = 'run-status running';
    this.status.replaceChildren(h('span.spinner'), `Running ${msg.languageName}…`);
    this.#setRunning(true);
    try {
      this.#job = await this.exec.start(
        { type: 'run', ...msg },
        {
          onPhase: (phase, command, interactive) => {
            this.console.line(`$ ${command}`, 'command');
            if (phase === 'compile') this.status.replaceChildren(h('span.spinner'), 'Compiling…');
            else {
              this.status.replaceChildren(h('span.spinner'), interactive ? 'Running · waiting for input' : 'Running…');
              if (interactive) {
                this.#inputRow.hidden = false;
                this.#input.focus({ preventScroll: true });
              }
            }
          },
          onOutput: (stream, data) => this.console.write(stream, data),
          onExit: (info) => {
            const { text, ok } = describeExit(info, this.opts.limits());
            this.console.line(text, ok ? 'ok' : 'fail');
            this.status.className = `run-status ${ok ? 'ok' : 'fail'}`;
            this.status.replaceChildren(icon(ok ? 'play' : 'x', 12), text);
            this.#setRunning(false);
          },
          onError: async (message, code) => {
            this.#setRunning(false);
            if (code === 'key' && (await this.opts.onNeedKey())) {
              this.run(msg);
              return;
            }
            this.console.line(message, 'fail');
            this.status.className = 'run-status fail';
            this.status.textContent = message;
          },
        },
      );
    } catch (err) {
      this.#setRunning(false);
      const message = (err as Error).message;
      this.console.line(message, 'fail');
      this.status.className = 'run-status fail';
      this.status.textContent = message;
    }
  }
}
