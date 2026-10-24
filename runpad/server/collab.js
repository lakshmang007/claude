import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/**
 * Real-time sync over WebSockets, speaking the y-websocket protocol:
 *   0 = sync (state vectors and updates), 1 = awareness (cursors and names),
 *   3 = query awareness, plus
 *   100 = JSON control messages (permissions, notices, re-authentication).
 *
 * The server holds the authoritative document. Updates from connections without write
 * permission are dropped; those clients get a read-only editor anyway.
 */

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_QUERY_AWARENESS = 3;
export const MSG_CONTROL = 100;

/** Close codes the client understands. */
export const CLOSE_LOCKED = 4401;
export const CLOSE_BAD_PATH = 4404;

const PING_MS = 30_000;

function encodeControl(data) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_CONTROL);
  encoding.writeVarString(enc, JSON.stringify(data));
  return encoding.toUint8Array(enc);
}

class Room {
  /**
   * @param {string} padPath
   * @param {import('./store.js').Pad} pad
   */
  constructor(padPath, pad) {
    this.path = padPath;
    this.pad = pad;
    /** @type {Map<import('ws').WebSocket, Conn>} */
    this.conns = new Map();
    this.destroyed = false;
    this.awareness = new awarenessProtocol.Awareness(pad.doc);
    this.awareness.setLocalState(null);

    this.onUpdate = (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const [ws] of this.conns) if (ws !== origin) send(ws, msg);
    };
    pad.doc.on('update', this.onUpdate);

    this.onAwareness = ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const conn = origin && this.conns.get(origin);
      if (conn) {
        for (const id of added) conn.clientIds.add(id);
        for (const id of removed) conn.clientIds.delete(id);
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const [ws] of this.conns) send(ws, msg);
    };
    this.awareness.on('update', this.onAwareness);
  }

  destroy() {
    this.destroyed = true;
    this.pad.doc.off('update', this.onUpdate);
    this.awareness.off('update', this.onAwareness);
    this.awareness.destroy();
  }
}

/**
 * @typedef {object} Conn
 * @property {string[]} tokens
 * @property {boolean} canWrite
 * @property {Set<number>} clientIds Awareness ids this connection controls.
 * @property {boolean} alive
 */

function send(ws, msg) {
  if (ws.readyState !== 1) return;
  ws.send(msg, (err) => {
    if (err) ws.terminate();
  });
}

export class CollabServer {
  /**
   * @param {{ store: import('./store.js').PadStore, access: import('./auth.js').Access }} deps
   */
  constructor({ store, access }) {
    this.store = store;
    this.access = access;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, Promise<Room>>} */
    this.opening = new Map();
    store.on('lock', (padPath) => this.refreshPermissions(padPath));
    this.pinger = setInterval(() => this.#ping(), PING_MS);
    this.pinger.unref?.();
  }

  #ping() {
    for (const room of this.rooms.values()) {
      for (const [ws, conn] of room.conns) {
        if (!conn.alive) {
          ws.terminate();
          continue;
        }
        conn.alive = false;
        ws.ping();
      }
    }
  }

  async #room(padPath) {
    const existing = this.rooms.get(padPath);
    if (existing) return existing;
    let pending = this.opening.get(padPath);
    if (!pending) {
      pending = this.store.acquire(padPath).then((pad) => {
        const room = new Room(padPath, pad);
        this.rooms.set(padPath, room);
        return room;
      });
      this.opening.set(padPath, pending);
      pending.finally(() => this.opening.delete(padPath));
    }
    return pending;
  }

  /** Number of people currently connected to a pad. */
  presence(padPath) {
    return this.rooms.get(padPath)?.conns.size ?? 0;
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {string} padPath
   * @param {string[]} tokens
   */
  async handle(ws, padPath, tokens) {
    const perm = this.access.check(padPath, tokens);
    if (!perm.canRead) {
      ws.close(CLOSE_LOCKED, 'locked');
      return;
    }
    ws.binaryType = 'arraybuffer';
    const queue = [];
    let room = null;
    ws.on('message', (data) => (room ? this.#onMessage(room, ws, data) : queue.push(data)));
    ws.on('pong', () => {
      const conn = room?.conns.get(ws);
      if (conn) conn.alive = true;
    });
    ws.on('error', () => ws.terminate());
    let closed = false;
    ws.on('close', () => {
      closed = true;
      if (room) this.#leave(room, ws);
    });

    let opened = await this.#room(padPath);
    // Another connection may have closed the room while this one waited for it.
    if (opened.destroyed) opened = await this.#room(padPath);
    room = opened;
    if (closed) {
      if (!room.conns.size) this.#close(room);
      return;
    }
    /** @type {Conn} */
    const conn = { tokens, canWrite: perm.canWrite, clientIds: new Set(), alive: true };
    room.conns.set(ws, conn);

    send(ws, encodeControl({ type: 'perm', canWrite: perm.canWrite, lock: perm.lock }));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.pad.doc);
    send(ws, encoding.toUint8Array(enc));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      send(ws, encoding.toUint8Array(aw));
    }
    for (const data of queue.splice(0)) this.#onMessage(room, ws, data);
  }

  /**
   * @param {Room} room
   * @param {import('ws').WebSocket} ws
   */
  #onMessage(room, ws, data) {
    const conn = room.conns.get(ws);
    if (!conn) return;
    try {
      const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const dec = decoding.createDecoder(buf);
      const type = decoding.readVarUint(dec);
      switch (type) {
        case MSG_SYNC: {
          const sub = decoding.readVarUint(dec);
          if (sub === syncProtocol.messageYjsSyncStep1) {
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MSG_SYNC);
            syncProtocol.writeSyncStep2(enc, room.pad.doc, decoding.readVarUint8Array(dec));
            send(ws, encoding.toUint8Array(enc));
          } else if (sub === syncProtocol.messageYjsSyncStep2 || sub === syncProtocol.messageYjsUpdate) {
            if (!conn.canWrite) {
              // Every client answers the server's sync request, usually with nothing new.
              const update = decoding.readVarUint8Array(dec);
              const { structs, ds } = Y.decodeUpdate(update);
              if (structs.length || ds.clients.size) {
                send(ws, encodeControl({ type: 'notice', level: 'warn', message: 'This pad is locked. Your changes were not saved.' }));
              }
              return;
            }
            // When storage is full, text typed now is taken out again; deleting still works.
            const inserted = [];
            const watch = (event) => {
              let pos = 0;
              for (const op of event.delta) {
                if (op.retain) pos += op.retain;
                else if (op.insert) {
                  inserted.push([pos, op.insert.length]);
                  pos += op.insert.length;
                }
              }
            };
            const full = this.store.isFull();
            if (full) room.pad.text.observe(watch);
            try {
              syncProtocol.readSyncStep2(dec, room.pad.doc, ws);
            } finally {
              if (full) room.pad.text.unobserve(watch);
            }
            if (inserted.length) {
              room.pad.doc.transact(() => {
                for (const [pos, len] of inserted.reverse()) room.pad.text.delete(pos, len);
              }, 'limit');
              send(ws, encodeControl({ type: 'notice', level: 'error', message: 'This server’s storage is full, so new text cannot be saved right now.' }));
            }
            if (this.store.enforceLimits(room.pad)) {
              const kb = Math.round(this.store.maxPadChars / 1024);
              send(ws, encodeControl({ type: 'notice', level: 'error', message: `Pads are limited to ${kb} KB; the end was cut off.` }));
            }
          }
          break;
        }
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
          break;
        case MSG_QUERY_AWARENESS: {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_AWARENESS);
          encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
          send(ws, encoding.toUint8Array(enc));
          break;
        }
        case MSG_CONTROL: {
          const msg = JSON.parse(decoding.readVarString(dec));
          if (msg?.type === 'auth' && Array.isArray(msg.tokens)) {
            conn.tokens = msg.tokens.filter((t) => typeof t === 'string').slice(0, 16);
            this.#recheck(room, ws, conn);
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error(`[collab] bad message on ${room.path}: ${err.message}`);
      ws.close(1003, 'bad message');
    }
  }

  #recheck(room, ws, conn) {
    const perm = this.access.check(room.path, conn.tokens);
    if (!perm.canRead) {
      ws.close(CLOSE_LOCKED, 'locked');
      return;
    }
    conn.canWrite = perm.canWrite;
    send(ws, encodeControl({ type: 'perm', canWrite: perm.canWrite, lock: perm.lock }));
  }

  /** Re-evaluates every connection on a pad and its sub-pads after a lock change. */
  refreshPermissions(lockPath) {
    for (const room of this.rooms.values()) {
      if (room.path !== lockPath && !room.path.startsWith(lockPath + '/')) continue;
      for (const [ws, conn] of room.conns) this.#recheck(room, ws, conn);
    }
  }

  #leave(room, ws) {
    const conn = room.conns.get(ws);
    if (!conn) return;
    room.conns.delete(ws);
    if (conn.clientIds.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clientIds], null);
    if (!room.conns.size) this.#close(room);
  }

  #close(room) {
    if (this.rooms.get(room.path) !== room) return;
    this.rooms.delete(room.path);
    room.destroy();
    this.store.release(room.pad);
  }

  close() {
    clearInterval(this.pinger);
    for (const room of this.rooms.values()) for (const [ws] of room.conns) ws.close(1001, 'server shutting down');
  }
}
