import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DocClient, startTestServer, waitFor, type TestServer } from './helpers';

// Protections for running RunPad as a public website.

const ADMIN = 'admin-token-for-tests-0123456789';
let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer({
    RUNPAD_EXEC: 'off',
    RUNPAD_ADMIN_TOKEN: ADMIN,
    RUNPAD_CONTACT: 'abuse@example.org',
    // About 2000 characters in all.
    RUNPAD_MAX_STORAGE_MB: String(2000 / 1024 / 1024),
    RUNPAD_MAX_SOCKETS_PER_IP: '3',
  });
});

afterAll(async () => {
  await srv?.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(srv.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('previews', () => {
  it('only show inside the editor, never as pages of their own', async () => {
    await fetch(`${srv.url}/phish`, { method: 'POST', body: '<form>Enter your bank password</form>' });
    const asPage = await fetch(`${srv.url}/_api/preview/-/phish/`, { headers: { 'Sec-Fetch-Dest': 'document' } });
    expect(asPage.status).toBe(403);
    expect(await asPage.text()).not.toContain('bank password');
    const inFrame = await fetch(`${srv.url}/_api/preview/-/phish/`, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    expect(inFrame.status).toBe(200);
    expect(inFrame.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  });
});

describe('admin token', () => {
  it('opens private pads and removes them', async () => {
    await fetch(`${srv.url}/abuse`, { method: 'POST', body: 'bad stuff' });
    expect((await post('/_api/lock', { path: 'abuse', password: 'their-secret', mode: 'private' })).status).toBe(200);
    expect((await fetch(`${srv.url}/abuse`)).status).toBe(401);
    expect(await (await fetch(`${srv.url}/abuse`, { headers: { 'X-Pad-Tokens': ADMIN } })).text()).toBe('bad stuff');
    expect((await post('/_api/delete', { path: 'abuse' }, { 'X-Pad-Tokens': ADMIN })).status).toBe(200);
    expect(await (await fetch(`${srv.url}/abuse`)).text()).toBe('');
    // A wrong or short token does nothing.
    await post('/_api/lock', { path: 'kept', password: 'their-secret', mode: 'private' });
    expect((await post('/_api/delete', { path: 'kept' }, { 'X-Pad-Tokens': ADMIN.slice(0, -1) })).status).toBe(401);
  });

  it('shares the contact for reports', async () => {
    expect((await (await fetch(`${srv.url}/_api/config`)).json()).contact).toBe('abuse@example.org');
  });
});

describe('storage cap', () => {
  it('lets pads shrink but not grow once full', async () => {
    expect((await fetch(`${srv.url}/big`, { method: 'POST', body: 'x'.repeat(2100) })).status).toBe(200);
    // Full now: more text is refused, over HTTP and live.
    expect((await fetch(`${srv.url}/more`, { method: 'POST', body: 'hello' })).status).toBe(507);
    const live = new DocClient(srv.ws, 'live-full');
    await waitFor(() => live.synced);
    live.text.insert(0, 'typed while full');
    await waitFor(() => live.notices.length > 0);
    await waitFor(() => live.text.toString() === '');
    expect(await (await fetch(`${srv.url}/live-full`)).text()).toBe('');
    live.close();
    // Shrinking is fine, and frees room.
    expect((await fetch(`${srv.url}/big`, { method: 'POST', body: 'x'.repeat(10) })).status).toBe(200);
    await waitFor(async () => (await fetch(`${srv.url}/more`, { method: 'POST', body: 'hello' })).status === 200);
  });
});

describe('per-client limits', () => {
  it('caps open connections from one address', async () => {
    const open = (path: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${srv.ws}/_ws/doc/${path}`);
        ws.on('open', () => resolve(101));
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        sockets.push(ws);
      });
    const sockets: WebSocket[] = [];
    expect([await open('a'), await open('b'), await open('c')]).toEqual([101, 101, 101]);
    expect(await open('d')).toBe(429);
    sockets[0].close();
    await waitFor(async () => (await open('e')) === 101);
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  it('rate-limits changes over HTTP', async () => {
    const limited = await startTestServer({ RUNPAD_EXEC: 'off', RUNPAD_WRITES_PER_MINUTE: '5' });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await fetch(`${limited.url}/spam${i}`, { method: 'POST', body: 'x' })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // Reading is not limited.
    expect((await fetch(`${limited.url}/spam0`)).status).toBe(200);
    await limited.close();
  });
});
