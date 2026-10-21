import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { loadConfig } from '../../server/config.js';
import { startServer } from '../../server/index.js';

export function tempDir(prefix = 'runpad-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface TestServer {
  url: string;
  data: string;
  ws: string;
  close(): Promise<void>;
  app: Awaited<ReturnType<typeof startServer>>;
}

/** Starts RunPad on a random port with throwaway data and work directories. */
export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const data = tempDir();
  const work = tempDir('runpad-work-');
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', RUNPAD_DATA: data, RUNPAD_WORK: work, ...env }, ['node', 'server']);
  const app = await startServer(config);
  return {
    url: `http://127.0.0.1:${app.port}`,
    data,
    ws: `ws://127.0.0.1:${app.port}`,
    app,
    async close() {
      await app.close();
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error('Timed out waiting for condition');
}

/** A minimal Node collaborator speaking RunPad's sync protocol. */
export class DocClient {
  doc = new Y.Doc();
  text = this.doc.getText('content');
  ws: WebSocket;
  synced = false;
  canWrite: boolean | null = null;
  notices: string[] = [];
  closeCode: number | null = null;
  opened: Promise<void>;

  constructor(base: string, padPath: string, tokens: string[] = []) {
    const enc = padPath.split('/').map(encodeURIComponent).join('/');
    this.ws = new WebSocket(`${base}/_ws/doc/${enc}${tokens.length ? `?t=${tokens.join(',')}` : ''}`);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve) => this.ws.on('open', () => resolve()));
    this.ws.on('open', () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeSyncStep1(e, this.doc);
      this.ws.send(encoding.toUint8Array(e));
    });
    this.ws.on('close', (code) => (this.closeCode = code));
    this.ws.on('message', (data: ArrayBuffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === 0) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        const sub = syncProtocol.readSyncMessage(dec, e, this.doc, this);
        if (encoding.length(e) > 1) this.ws.send(encoding.toUint8Array(e));
        if (sub === 1) this.synced = true;
      } else if (type === 100) {
        const msg = JSON.parse(decoding.readVarString(dec));
        if (msg.type === 'perm') this.canWrite = msg.canWrite;
        if (msg.type === 'notice') this.notices.push(msg.message);
      }
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, update);
      this.ws.send(encoding.toUint8Array(e));
    });
  }

  sendControl(data: unknown) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 100);
    encoding.writeVarString(e, JSON.stringify(data));
    this.ws.send(encoding.toUint8Array(e));
  }

  close() {
    this.ws.close();
  }
}

export interface ExecEvent {
  type: string;
  id?: string;
  [key: string]: unknown;
}

/** Client for /_ws/exec that collects each job's events. */
export class ExecTestClient {
  ws: WebSocket;
  hello: Promise<ExecEvent>;
  #waiters = new Map<string, { events: ExecEvent[]; resolve: (e: ExecEvent[]) => void; onEvent?: (e: ExecEvent) => void }>();
  #n = 0;

  constructor(base: string, headers: Record<string, string> = {}) {
    this.ws = new WebSocket(`${base}/_ws/exec`, { headers });
    this.hello = new Promise((resolve) => {
      this.ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as ExecEvent;
        if (msg.type === 'hello') return resolve(msg);
        const w = msg.id ? this.#waiters.get(msg.id) : undefined;
        if (!w) return;
        w.events.push(msg);
        w.onEvent?.(msg);
        if (msg.type === 'exit' || msg.type === 'error') {
          this.#waiters.delete(msg.id!);
          w.resolve(w.events);
        }
      });
    });
  }

  job(msg: Record<string, unknown>, onEvent?: (e: ExecEvent, send: (m: Record<string, unknown>) => void) => void): Promise<ExecEvent[]> {
    const id = `j${++this.#n}`;
    const send = (m: Record<string, unknown>) => this.ws.send(JSON.stringify({ ...m, id }));
    return new Promise((resolve) => {
      this.#waiters.set(id, { events: [], resolve, onEvent: onEvent && ((e) => onEvent(e, send)) });
      send(msg);
    });
  }

  close() {
    this.ws.close();
  }
}

export const stdout = (events: ExecEvent[]) =>
  events
    .filter((e) => e.type === 'out' && e.stream === 'stdout')
    .map((e) => e.data)
    .join('');

export const stderr = (events: ExecEvent[]) =>
  events
    .filter((e) => e.type === 'out' && e.stream === 'stderr')
    .map((e) => e.data)
    .join('');

export const exitOf = (events: ExecEvent[]) => events.find((e) => e.type === 'exit' || e.type === 'error')!;
