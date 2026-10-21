import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Access, TokenSigner, hashPassword, parseTokens, verifyPassword } from '../../server/auth.js';
import { PadStore, padId } from '../../server/store.js';
import { tempDir } from './helpers';

const dirs: string[] = [];
const history = { intervalMs: 60_000, maxEntries: 5, maxBytes: 1024 * 1024 };

async function newStore(dataDir = tempDir()) {
  dirs.push(dataDir);
  return new PadStore({ dataDir, maxPadChars: 1000, history, unloadDelayMs: 10 }).init();
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('PadStore', () => {
  it('saves text and reloads it with the same Yjs identity', async () => {
    const store = await newStore();
    await store.setText('a/b', 'hello');
    const pad = await store.acquire('a/b');
    const state = Y.encodeStateVector(pad.doc);
    store.release(pad);
    await store.flush();

    const again = await newStore(store.dataDir);
    expect(await again.getText('a/b')).toBe('hello');
    const reloaded = await again.acquire('a/b');
    // Same client ids and clocks: a collaborator that reconnects merges without duplicates.
    expect(Y.encodeStateVector(reloaded.doc)).toEqual(state);
    expect(again.info('a/b')).toMatchObject({ path: 'a/b', size: 5, lock: null });
  });

  it('leaves nothing on disk for pads that stay empty', async () => {
    const store = await newStore();
    const pad = await store.acquire('empty');
    pad.text.insert(0, 'x');
    pad.text.delete(0, 1);
    store.release(pad);
    await store.save(pad);
    expect(store.info('empty')).toBeNull();
    expect(fs.existsSync(path.join(store.padsDir, `${padId('empty')}.ystate`))).toBe(false);
  });

  it('lists sub-pads, including folders that only have deeper pads', async () => {
    const store = await newStore();
    await store.setText('lab/a.c', 'int main(){}');
    await store.setText('lab/deep/x', 'x');
    await store.setText('labx', 'not a child');
    await store.touch('lab/empty.txt');
    const kids = store.children('lab');
    expect(kids.map((k) => [k.name, k.exists, k.hasChildren])).toEqual([
      ['a.c', true, false],
      ['deep', false, true],
      ['empty.txt', true, false],
    ]);
  });

  it('keeps history and restores it', async () => {
    const store = await newStore();
    await store.setText('h', 'one');
    await store.setText('h', 'two');
    await store.setText('h', 'three');
    const items = await store.history('h');
    expect(items.map((i: { size: number }) => i.size)).toEqual([5, 3, 3]);
    const first = items.at(-1)!;
    expect((await store.historyItem('h', first.id))!.text).toBe('one');
    expect(await store.restore('h', first.id)).toBe(true);
    expect(await store.getText('h')).toBe('one');
    expect((await store.history('h'))[0].size).toBe(3);
  });

  it('trims history to its limits', async () => {
    const store = await newStore();
    for (let i = 0; i < 9; i++) await store.setText('t', `v${i}`);
    const items = await store.history('t');
    expect(items).toHaveLength(5);
    expect((await store.historyItem('t', items[0].id))!.text).toBe('v8');
  });

  it('cuts text past the size limit', async () => {
    const store = await newStore();
    const pad = await store.acquire('big');
    pad.text.insert(0, 'x'.repeat(1500));
    expect(store.enforceLimits(pad)).toBe(true);
    expect(pad.text.length).toBe(1000);
    store.release(pad);
    await expect(store.setText('big', 'y'.repeat(1001))).rejects.toThrow(/too large/);
  });

  it('removes a pad with its history and lock', async () => {
    const store = await newStore();
    await store.setText('gone', 'a');
    await store.setText('gone', 'b');
    await store.setLock('gone', { mode: 'readonly', salt: 's', hash: 'h' });
    await store.remove('gone');
    expect(store.info('gone')).toBeNull();
    expect(await store.history('gone')).toEqual([]);
    expect(store.lockChain('gone')).toEqual([]);
  });

  it('gives each new lock a new version', async () => {
    const store = await newStore();
    const v1 = await store.setLock('p', { mode: 'readonly', salt: 's', hash: 'h' });
    await store.setLock('p', null);
    const v2 = await store.setLock('p', { mode: 'private', salt: 's', hash: 'h' });
    expect(v2).toBeGreaterThan(v1);
    expect(store.lockChain('p/q')).toEqual([{ path: 'p', mode: 'private', version: v2 }]);
  });
});

describe('locks and tokens', () => {
  it('hashes and verifies passwords', async () => {
    const lock = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', lock)).toBe(true);
    expect(await verifyPassword('wrong', lock)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });

  it('signs tokens that cannot be forged or reused after expiry', () => {
    const signer = new TokenSigner(Buffer.alloc(32, 1));
    const token = signer.sign('a', 5);
    expect(signer.verify(token)).toEqual({ path: 'a', version: 5 });
    expect(new TokenSigner(Buffer.alloc(32, 2)).verify(token)).toBeNull();
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ p: 'b', v: 5, e: Date.now() + 1e9 })).toString('base64url');
    expect(signer.verify(`${forged}.${mac}`)).toBeNull();
    expect(signer.verify(`${payload}.`)).toBeNull();
    expect(signer.verify(token, Date.now() + 31 * 864e5)).toBeNull();
    expect(parseTokens(' a, ,b ')).toEqual(['a', 'b']);
  });

  it('applies the lock chain', async () => {
    const store = await newStore();
    const signer = new TokenSigner(Buffer.alloc(32, 3));
    const access = new Access(store, signer);
    expect(access.check('x/y', [])).toMatchObject({ canRead: true, canWrite: true, lock: null });

    const ro = await store.setLock('ro', { mode: 'readonly', salt: 's', hash: 'h' });
    expect(access.check('ro/sub', [])).toMatchObject({ canRead: true, canWrite: false, lock: { path: 'ro', mode: 'readonly' } });
    expect(access.check('ro/sub', [signer.sign('ro', ro)])).toMatchObject({ canRead: true, canWrite: true });
    expect(access.check('ro/sub', [signer.sign('ro', ro - 1)]).canWrite).toBe(false);

    const priv = await store.setLock('priv', { mode: 'private', salt: 's', hash: 'h' });
    const inner = await store.setLock('priv/open', { mode: 'readonly', salt: 's', hash: 'h' });
    // A read-only lock inside a private one does not make the inside public.
    expect(access.check('priv/open/x', [])).toMatchObject({ canRead: false, canWrite: false, lock: { mode: 'private' } });
    expect(access.check('priv/open/x', [signer.sign('priv/open', inner)])).toMatchObject({ canRead: true, canWrite: true });
    expect(access.check('priv/other', [signer.sign('priv/open', inner)]).canRead).toBe(false);
    expect(access.check('priv/other', [signer.sign('priv', priv)])).toMatchObject({ canRead: true, canWrite: true });
  });
});
