import type { ServerConfig } from './api';
import { getRunKey } from './tokens';

/** Client for /_ws/exec: runs programs and terminal commands on the server. */

export interface ExitInfo {
  phase: 'compile' | 'run' | 'reset';
  code: number | null;
  signal: string | null;
  reason: null | 'timeout' | 'killed' | 'output' | 'cpu' | 'filesize' | 'spawn';
  timeMs: number;
  error?: string;
}

export interface JobHandlers {
  onPhase?(phase: 'compile' | 'run', command: string, interactive: boolean): void;
  onOutput?(stream: 'stdout' | 'stderr', data: string): void;
  onExit?(info: ExitInfo): void;
  onError?(message: string, code?: string): void;
}

export interface JobHandle {
  id: string;
  stdin(text: string): void;
  eof(): void;
  kill(): void;
}

type Outgoing =
  | { type: 'run'; language: string; code: string; stdin: string; pad?: string; tokens?: string[] }
  | { type: 'cmd'; command: string; pad: string; language: string; code: string; tokens?: string[] }
  | { type: 'reset'; pad: string; tokens?: string[] };

export class ExecClient {
  #ws: WebSocket | null = null;
  #open: Promise<WebSocket> | null = null;
  #jobs = new Map<string, JobHandlers>();
  info: ServerConfig['exec'] | null = null;

  #connect(): Promise<WebSocket> {
    if (this.#ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.#ws);
    if (this.#open) return this.#open;
    this.#open = new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/_ws/exec`);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.#ws = ws;
        this.#open = null;
        resolve(ws);
      };
      ws.onmessage = (event) => this.#onMessage(JSON.parse(String(event.data)));
      ws.onclose = () => {
        if (this.#ws === ws) this.#ws = null;
        this.#open = null;
        for (const [id, handlers] of this.#jobs) {
          handlers.onError?.('Lost the connection to the server.');
          this.#jobs.delete(id);
        }
        if (!opened) reject(new Error('Could not connect to the server to run code.'));
      };
    });
    return this.#open;
  }

  #onMessage(msg: { type: string; id?: string; [k: string]: unknown }): void {
    if (msg.type === 'hello') {
      this.info = msg as unknown as ServerConfig['exec'];
      return;
    }
    const handlers = msg.id ? this.#jobs.get(msg.id) : undefined;
    if (!handlers) return;
    switch (msg.type) {
      case 'phase':
        handlers.onPhase?.(msg.phase as 'compile' | 'run', String(msg.command ?? ''), !!msg.interactive);
        break;
      case 'out':
        handlers.onOutput?.(msg.stream as 'stdout' | 'stderr', String(msg.data ?? ''));
        break;
      case 'exit':
        this.#jobs.delete(msg.id!);
        handlers.onExit?.(msg as unknown as ExitInfo);
        break;
      case 'error':
        this.#jobs.delete(msg.id!);
        handlers.onError?.(String(msg.message), msg.code as string | undefined);
        break;
    }
  }

  /** Starts a job. Rejects only if the server cannot be reached. */
  async start(msg: Outgoing, handlers: JobHandlers): Promise<JobHandle> {
    const ws = await this.#connect();
    const id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    this.#jobs.set(id, handlers);
    ws.send(JSON.stringify({ ...msg, id, key: getRunKey() }));
    const send = (data: unknown) => {
      if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(data));
    };
    return {
      id,
      stdin: (text) => send({ type: 'stdin', id, data: text }),
      eof: () => send({ type: 'eof', id }),
      kill: () => send({ type: 'kill', id }),
    };
  }
}

/** One-line description of how a program ended. */
export function describeExit(info: ExitInfo, limits?: ServerConfig['exec']['limits']): { text: string; ok: boolean } {
  const secs = (info.timeMs / 1000).toFixed(info.timeMs < 10_000 ? 2 : 1);
  if (info.phase === 'compile' && !info.reason) {
    return { text: info.code === null ? `Compiler stopped (${info.signal})` : 'Compilation failed', ok: false };
  }
  switch (info.reason) {
    case 'timeout':
      return { text: `Stopped: time limit exceeded (${secs} s)`, ok: false };
    case 'killed':
      return { text: 'Stopped', ok: false };
    case 'output':
      return { text: `Stopped: too much output (limit ${limits?.outputKb ?? '?'} KB)`, ok: false };
    case 'cpu':
      return { text: `Stopped: CPU time limit exceeded (${limits?.cpuSeconds ?? '?'} s)`, ok: false };
    case 'filesize':
      return { text: 'Stopped: a file grew past the size limit', ok: false };
    case 'spawn':
      return { text: `Could not start the program${info.error ? `: ${info.error}` : ''}`, ok: false };
  }
  if (info.signal) {
    const names: Record<string, string> = {
      SIGSEGV: 'Segmentation fault (invalid memory access)',
      SIGABRT: 'Aborted',
      SIGFPE: 'Arithmetic error (e.g. division by zero)',
      SIGKILL: 'Killed (out of memory?)',
      SIGBUS: 'Bus error',
      SIGILL: 'Illegal instruction',
      SIGPIPE: 'Broken pipe',
    };
    return { text: `${names[info.signal] ?? `Terminated by ${info.signal}`} · ${secs} s`, ok: false };
  }
  return { text: `Exited with code ${info.code} · ${secs} s`, ok: info.code === 0 };
}
