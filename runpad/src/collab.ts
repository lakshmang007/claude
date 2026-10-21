import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { LockState } from './api';
import { Emitter } from './util';

/**
 * Keeps a Y.Doc in sync with the server over a WebSocket (the y-websocket protocol plus
 * RunPad's control messages). Reconnects with backoff; edits made while offline are kept
 * in the document and merged when the connection comes back.
 */

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_CONTROL = 100;
const CLOSE_LOCKED = 4401;

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'locked';

type Events = {
  status: [ConnectionStatus];
  synced: [];
  perm: [{ canWrite: boolean; lock: LockState | null }];
  notice: [{ level: string; message: string }];
};

export class PadProvider extends Emitter<Events> {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  status: ConnectionStatus = 'connecting';
  synced = false;
  canWrite = false;
  lock: LockState | null = null;
  #ws: WebSocket | null = null;
  #attempts = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  constructor(
    readonly path: string,
    private tokens: () => string[],
    doc = new Y.Doc(),
  ) {
    super();
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on('update', this.#onDocUpdate);
    this.awareness.on('update', this.#onAwarenessUpdate);
    window.addEventListener('beforeunload', this.#onUnload);
    this.connect();
  }

  #url(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const enc = this.path.split('/').map(encodeURIComponent).join('/');
    const t = this.tokens();
    return `${proto}://${location.host}/_ws/doc/${enc}${t.length ? `?t=${encodeURIComponent(t.join(','))}` : ''}`;
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  connect(): void {
    if (this.#destroyed || this.#ws) return;
    clearTimeout(this.#retry);
    this.#setStatus('connecting');
    const ws = new WebSocket(this.#url());
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempts = 0;
      this.#setStatus('online');
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      ws.send(encoding.toUint8Array(enc));
      if (this.awareness.getLocalState() !== null) this.#sendAwareness([this.doc.clientID]);
    };

    ws.onmessage = (event) => this.#onMessage(new Uint8Array(event.data as ArrayBuffer));

    ws.onclose = (event) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.synced = false;
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      if (this.#destroyed) return;
      if (event.code === CLOSE_LOCKED) {
        this.canWrite = false;
        this.#setStatus('locked');
        return;
      }
      this.#setStatus('offline');
      const delay = Math.min(10_000, 400 * 2 ** this.#attempts++) * (0.75 + Math.random() / 2);
      this.#retry = setTimeout(() => this.connect(), delay);
    };
  }

  /** New tokens (after unlocking or locking): re-checked without reconnecting if possible. */
  reauth(): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#sendControl({ type: 'auth', tokens: this.tokens() });
    } else if (!this.#ws) {
      this.#attempts = 0;
      this.connect();
    }
  }

  /** Reconnects now (the user pressed retry, or the tab came back online). */
  reconnect(): void {
    if (this.#ws) return;
    this.#attempts = 0;
    this.connect();
  }

  #onMessage(buf: Uint8Array): void {
    const dec = decoding.createDecoder(buf);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const sub = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.#send(encoding.toUint8Array(enc));
      if (sub === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.emit('synced');
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
    } else if (type === MSG_CONTROL) {
      const msg = JSON.parse(decoding.readVarString(dec));
      if (msg.type === 'perm') {
        this.canWrite = !!msg.canWrite;
        this.lock = msg.lock ?? null;
        this.emit('perm', { canWrite: this.canWrite, lock: this.lock });
      } else if (msg.type === 'notice') {
        this.emit('notice', { level: msg.level, message: msg.message });
      }
    }
  }

  #send(data: Uint8Array): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(data as Uint8Array<ArrayBuffer>);
  }

  #sendControl(data: unknown): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_CONTROL);
    encoding.writeVarString(enc, JSON.stringify(data));
    this.#send(encoding.toUint8Array(enc));
  }

  #sendAwareness(clients: number[]): void {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.#send(encoding.toUint8Array(enc));
  }

  #onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.#send(encoding.toUint8Array(enc));
  };

  #onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === this) return;
    this.#sendAwareness(added.concat(updated, removed));
  };

  #onUnload = () => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'unload');
  };

  destroy(): void {
    this.#destroyed = true;
    clearTimeout(this.#retry);
    window.removeEventListener('beforeunload', this.#onUnload);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.doc.off('update', this.#onDocUpdate);
    this.awareness.off('update', this.#onAwarenessUpdate);
    this.#ws?.close();
    this.#ws = null;
    this.awareness.destroy();
    this.doc.destroy();
  }
}
