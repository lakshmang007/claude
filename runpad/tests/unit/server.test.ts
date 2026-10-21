import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { DocClient, startTestServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer({ RUNPAD_EXEC: 'off' });
});

afterAll(async () => {
  await srv?.close();
});

async function post(path: string, body: unknown, tokens: string[] = []) {
  const res = await fetch(srv.url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pad-Tokens': tokens.join(',') },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

describe('raw access, like Dontpad from a terminal', () => {
  it('writes, reads and appends with plain HTTP', async () => {
    let res = await fetch(`${srv.url}/cli/notes`, { method: 'POST', body: 'line 1\n' });
    expect(res.status).toBe(200);
    expect(await (await fetch(`${srv.url}/cli/notes`)).text()).toBe('line 1\n');
    res = await fetch(`${srv.url}/cli/notes?append`, { method: 'POST', body: 'line 2\n' });
    expect(await (await fetch(`${srv.url}/_api/raw/cli/notes`)).text()).toBe('line 1\nline 2\n');
    res = await fetch(`${srv.url}/cli/notes`, { method: 'PUT', body: 'replaced' });
    expect(await (await fetch(`${srv.url}/cli/notes?raw`)).text()).toBe('replaced');
  });

  it('serves raw text safely and offers downloads', async () => {
    await fetch(`${srv.url}/cli/page.c`, { method: 'POST', body: '<script>alert(1)</script>' });
    const res = await fetch(`${srv.url}/cli/page.c?download`);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('content-disposition')).toContain('filename="page.c"');
  });

  it('gives browsers the app and rejects bad names', async () => {
    const page = await fetch(`${srv.url}/cli/notes`, { headers: { Accept: 'text/html' } });
    // dist/ may not be built in a test run; either the app or the build hint comes back.
    expect([200, 503]).toContain(page.status);
    expect((await fetch(`${srv.url}/_nope`)).status).toBe(404);
    expect((await fetch(`${srv.url}/a/..%2f..%2fetc`)).status).toBe(404);
  });

  it('downloads a pad and its sub-pads as a zip', async () => {
    await fetch(`${srv.url}/zipme`, { method: 'POST', body: 'import util\nprint("x", util.X)\n' });
    await fetch(`${srv.url}/zipme/util.py`, { method: 'POST', body: 'X = 1\n' });
    const res = await fetch(`${srv.url}/_api/zip/zipme`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(buf.includes(Buffer.from('zipme/main.py'))).toBe(true);
    expect(buf.includes(Buffer.from('zipme/util.py'))).toBe(true);
  });

  it('serves HTML previews in a sandbox', async () => {
    await fetch(`${srv.url}/site`, { method: 'POST', body: '<h1>hi</h1>' });
    await fetch(`${srv.url}/site/style.css`, { method: 'POST', body: 'h1{color:red}' });
    const page = await fetch(`${srv.url}/_api/preview/-/site/`);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(await page.text()).toBe('<h1>hi</h1>');
    const css = await fetch(`${srv.url}/_api/preview/-/site/style.css`);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
  });
});

describe('locks over HTTP', () => {
  it('locks, unlocks and removes a read-only lock', async () => {
    await fetch(`${srv.url}/team`, { method: 'POST', body: 'v1' });
    const lock = await post('/_api/lock', { path: 'team', password: 'pass1234', mode: 'readonly' });
    expect(lock.status).toBe(200);
    const token = lock.data.token as string;

    expect((await fetch(`${srv.url}/team`, { method: 'POST', body: 'hacked' })).status).toBe(403);
    expect((await fetch(`${srv.url}/team/child`, { method: 'POST', body: 'x' })).status).toBe(403);
    expect(await (await fetch(`${srv.url}/team`)).text()).toBe('v1');
    const ok = await fetch(`${srv.url}/team`, { method: 'POST', body: 'v2', headers: { 'X-Pad-Tokens': token } });
    expect(ok.status).toBe(200);

    expect((await post('/_api/unlock', { path: 'team/child', password: 'nope' })).status).toBe(403);
    const unlocked = await post('/_api/unlock', { path: 'team/child', password: 'pass1234' });
    expect(unlocked.data.lockPath).toBe('team');

    expect((await post('/_api/lock/remove', { path: 'team' })).status).toBe(403);
    expect((await post('/_api/lock/remove', { path: 'team' }, [unlocked.data.token])).status).toBe(200);
    expect((await fetch(`${srv.url}/team`, { method: 'POST', body: 'v3' })).status).toBe(200);
    // Old tokens die with the lock.
    const relock = await post('/_api/lock', { path: 'team', password: 'pass1234', mode: 'readonly' });
    const info = await (await fetch(`${srv.url}/_api/pad?path=team`, { headers: { 'X-Pad-Tokens': token } })).json();
    expect(info.canWrite).toBe(false);
    expect(relock.status).toBe(200);
  });

  it('hides private pads', async () => {
    await fetch(`${srv.url}/secret`, { method: 'POST', body: 'diary' });
    await fetch(`${srv.url}/secret/sub`, { method: 'POST', body: 'more' });
    const { data } = await post('/_api/lock', { path: 'secret', password: 'pass1234', mode: 'private' });
    expect((await fetch(`${srv.url}/secret`)).status).toBe(401);
    expect((await fetch(`${srv.url}/secret/sub`)).status).toBe(401);
    expect((await fetch(`${srv.url}/_api/children?path=secret`)).status).toBe(401);
    expect((await fetch(`${srv.url}/_api/history?path=secret`)).status).toBe(401);
    expect((await fetch(`${srv.url}/_api/preview/-/secret/`)).status).toBe(401);
    expect(await (await fetch(`${srv.url}/secret?t=${data.token}`)).text()).toBe('diary');
    const zip = Buffer.from(await (await fetch(`${srv.url}/_api/zip/secret?t=${data.token}`)).arrayBuffer());
    expect(zip.includes(Buffer.from('secret/sub'))).toBe(true);
  });

  it('rate-limits password guesses', async () => {
    await post('/_api/lock', { path: 'guess', password: 'pass1234', mode: 'readonly' });
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await post('/_api/unlock', { path: 'guess', password: `x${i}` })).status;
    expect(last).toBe(429);
  });

  it('restores history and deletes files', async () => {
    await fetch(`${srv.url}/hist`, { method: 'POST', body: 'first' });
    await fetch(`${srv.url}/hist`, { method: 'POST', body: 'second' });
    const items = (await (await fetch(`${srv.url}/_api/history?path=hist`)).json()).items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const oldest = items.at(-1);
    expect((await post('/_api/history/restore', { path: 'hist', id: oldest.id })).status).toBe(200);
    expect(await (await fetch(`${srv.url}/hist`)).text()).toBe('first');

    await post('/_api/touch', { path: 'hist/new.txt' });
    let kids = (await (await fetch(`${srv.url}/_api/children?path=hist`)).json()).children;
    expect(kids.map((k: { name: string }) => k.name)).toEqual(['new.txt']);
    await post('/_api/delete', { path: 'hist/new.txt' });
    kids = (await (await fetch(`${srv.url}/_api/children?path=hist`)).json()).children;
    expect(kids).toEqual([]);
  });
});

describe('live sync', () => {
  it('keeps a browser edit in history when asked before a replacement', async () => {
    await fetch(`${srv.url}/snap`, { method: 'POST', body: 'from curl' });
    const a = new DocClient(srv.ws, 'snap');
    await waitFor(() => a.synced);
    a.text.insert(a.text.length, ' + typed');
    await waitFor(async () => (await (await fetch(`${srv.url}/snap`)).text()) === 'from curl + typed');
    expect((await post('/_api/snapshot', { path: 'snap' })).status).toBe(200);
    const items = (await (await fetch(`${srv.url}/_api/history?path=snap`)).json()).items;
    const latest = await (await fetch(`${srv.url}/_api/history/item?path=snap&id=${items[0].id}`)).json();
    expect(latest.text).toBe('from curl + typed');
    a.close();
  });

  it('syncs edits between collaborators and to HTTP readers', async () => {
    const a = new DocClient(srv.ws, 'live/doc');
    const b = new DocClient(srv.ws, 'live/doc');
    await waitFor(() => a.synced && b.synced);
    a.text.insert(0, 'hello');
    await waitFor(() => b.text.toString() === 'hello');
    b.text.insert(5, ' world');
    await waitFor(() => a.text.toString() === 'hello world');
    expect(await (await fetch(`${srv.url}/live/doc`)).text()).toBe('hello world');
    // A raw write reaches open editors.
    await fetch(`${srv.url}/live/doc`, { method: 'POST', body: 'hello there world' });
    await waitFor(() => a.text.toString() === 'hello there world' && b.text.toString() === 'hello there world');
    a.close();
    b.close();
  });

  it('merges a reconnecting client without duplicating text', async () => {
    const a = new DocClient(srv.ws, 'live/reconnect');
    await waitFor(() => a.synced);
    a.text.insert(0, 'abc');
    await waitFor(async () => (await (await fetch(`${srv.url}/live/reconnect`)).text()) === 'abc');
    a.close();
    // A new connection reusing the same document (as a browser tab does after a drop).
    const again = new DocClient(srv.ws, 'live/reconnect');
    copyState(again, a);
    await waitFor(() => again.synced);
    await new Promise((r) => setTimeout(r, 200));
    expect(await (await fetch(`${srv.url}/live/reconnect`)).text()).toBe('abc');
    again.close();
  });

  it('drops edits from read-only connections and refuses private pads', async () => {
    await fetch(`${srv.url}/ro`, { method: 'POST', body: 'locked text' });
    const { data } = await post('/_api/lock', { path: 'ro', password: 'pass1234', mode: 'readonly' });
    const reader = new DocClient(srv.ws, 'ro');
    await waitFor(() => reader.synced && reader.canWrite === false);
    expect(reader.text.toString()).toBe('locked text');
    expect(reader.notices).toEqual([]);
    reader.text.insert(0, 'evil ');
    await waitFor(() => reader.notices.length > 0);
    expect(await (await fetch(`${srv.url}/ro?t=${data.token}`)).text()).toBe('locked text');
    // Unlocking on an open connection.
    reader.sendControl({ type: 'auth', tokens: [data.token] });
    await waitFor(() => reader.canWrite === true);
    reader.close();

    await fetch(`${srv.url}/hidden`, { method: 'POST', body: 'x' });
    const priv = await post('/_api/lock', { path: 'hidden', password: 'pass1234', mode: 'private' });
    const outsider = new DocClient(srv.ws, 'hidden/deeper');
    await waitFor(() => outsider.closeCode !== null);
    expect(outsider.closeCode).toBe(4401);
    expect(outsider.text.toString()).toBe('');
    const insider = new DocClient(srv.ws, 'hidden', [priv.data.token]);
    await waitFor(() => insider.synced);
    expect(insider.text.toString()).toBe('x');
    // Locking while connected: an open connection without the token is closed.
    const watcher = new DocClient(srv.ws, 'later');
    await waitFor(() => watcher.synced);
    await post('/_api/lock', { path: 'later', password: 'pass1234', mode: 'private' });
    await waitFor(() => watcher.closeCode === 4401);
    insider.close();
  });

  it('rejects cross-site WebSocket connections', async () => {
    const ws = new WebSocket(`${srv.ws}/_ws/doc/x`, { headers: { Origin: 'https://evil.example' } });
    const status = await new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
    expect(status).toBe(403);
  });
});

/** Copies one client's document into another, as a browser tab keeps it across reconnects. */
function copyState(target: DocClient, source: DocClient) {
  Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc), target);
}
