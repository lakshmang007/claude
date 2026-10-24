import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LANGUAGES } from '../../shared/langs.js';
import { javaMainClass } from '../../server/languages.js';
import { ExecTestClient, exitOf, startTestServer, stderr, stdout, tempDir, type ExecEvent, type TestServer } from './helpers';

let srv: TestServer;
let client: ExecTestClient;
let available: string[] = [];

beforeAll(async () => {
  srv = await startTestServer({ RUNPAD_RUN_TIMEOUT: '3', RUNPAD_INTERACTIVE_TIMEOUT: '5', RUNPAD_CPU_SECONDS: '2', RUNPAD_MAX_OUTPUT_KB: '64', RUNPAD_RUNS_PER_MINUTE: '1000', RUNPAD_MAX_PER_CLIENT: '4' });
  client = new ExecTestClient(srv.ws);
  const hello = await client.hello;
  available = (hello.languages as Array<{ id: string }>).map((l) => l.id);
});

afterAll(async () => {
  client?.close();
  await srv?.close();
});

const run = (language: string, code: string, stdin = '', extra: Record<string, unknown> = {}) => client.job({ type: 'run', language, code, stdin, ...extra });

describe('running programs', () => {
  it('runs every starter program the server supports', async () => {
    expect(available).toContain('python');
    for (const lang of LANGUAGES) {
      if (!lang.template || !available.includes(lang.id)) continue;
      const events = await run(lang.id, lang.template, 'Ada');
      expect(exitOf(events), lang.id).toMatchObject({ type: 'exit', phase: 'run', code: 0 });
      expect(stdout(events), lang.id).toMatch(/Hello, (Ada|world)!/);
    }
  }, 120_000);

  it('feeds typed input to an interactive program', async () => {
    const events = await client.job({ type: 'run', language: 'python', code: 'a = input("a? ")\nb = input("b? ")\nprint(int(a) + int(b))', stdin: '' }, (e, send) => {
      if (e.type === 'out' && String(e.data).includes('a? ')) send({ type: 'stdin', data: '2\n' });
      if (e.type === 'out' && String(e.data).includes('b? ')) send({ type: 'stdin', data: '40\n' });
    });
    expect(stdout(events)).toBe('a? b? 42\n');
    const phase = events.find((e) => e.type === 'phase') as ExecEvent;
    expect(phase.interactive).toBe(true);
  });

  it('ends input on request', async () => {
    const events = await client.job({ type: 'run', language: 'python', code: 'import sys\nprint(len(sys.stdin.read()))', stdin: '' }, (e, send) => {
      if (e.type === 'phase') {
        send({ type: 'stdin', data: 'abc' });
        send({ type: 'eof' });
      }
    });
    expect(stdout(events)).toBe('3\n');
  });

  it('reports compile errors without running', async () => {
    if (!available.includes('c')) return;
    const events = await run('c', 'int main(void) { return nope; }', 'x');
    expect(exitOf(events)).toMatchObject({ phase: 'compile', code: 1 });
    expect(stderr(events)).toMatch(/main\.c:1:\d+: error/);
    expect(events.filter((e) => e.type === 'phase').map((e) => e.phase)).toEqual(['compile']);
  });

  it('stops runaway programs', async () => {
    const loop = await run('python', 'while True: pass', 'x');
    expect(exitOf(loop)).toMatchObject({ reason: 'cpu' });
    const sleepy = await run('python', 'import time\ntime.sleep(60)', 'x');
    expect(exitOf(sleepy)).toMatchObject({ reason: 'timeout' });
    const chatty = await run('python', 'while True: print("y" * 100)', 'x');
    expect(exitOf(chatty)).toMatchObject({ reason: 'output' });
    expect(stdout(chatty).length).toBeLessThanOrEqual(64 * 1024);
  }, 30_000);

  it('can be killed', async () => {
    const events = await client.job({ type: 'run', language: 'python', code: 'import time\nprint("go", flush=True)\ntime.sleep(30)', stdin: '' }, (e, send) => {
      if (e.type === 'out') send({ type: 'kill' });
    });
    expect(exitOf(events)).toMatchObject({ reason: 'killed' });
  });

  it('reports crashes', async () => {
    const events = await run('python', 'import os, signal\nos.kill(os.getpid(), signal.SIGSEGV)', 'x');
    expect(exitOf(events)).toMatchObject({ code: null, signal: 'SIGSEGV' });
  });

  it('does not leak the server environment', async () => {
    process.env.RUNPAD_TEST_SECRET = 'leak-me';
    const events = await run('python', 'import os\nprint(os.environ.get("RUNPAD_TEST_SECRET"), os.environ["HOME"] == os.getcwd())', 'x');
    expect(stdout(events)).toBe('None True\n');
  });

  it('keeps programs away from RunPad data, root and the network', async () => {
    await fetch(`${srv.url}/victim`, { method: 'POST', body: 'private stuff' });
    const code = [
      'import os, socket',
      `d = ${JSON.stringify(srv.data)}`,
      'print("secret", os.path.exists(os.path.join(d, "secret.key")))',
      'try:',
      '    print("pads", len(os.listdir(os.path.join(d, "pads"))))',
      'except OSError:',
      '    print("pads hidden")',
      // The real uid, seen through any user namespace mapping.
      'real = os.getuid()',
      'for line in open("/proc/self/uid_map"):',
      '    inside, outside, count = map(int, line.split())',
      '    if inside <= os.getuid() < inside + count: real = outside + os.getuid() - inside',
      'print("uid", real)',
      'try:',
      '    socket.create_connection(("1.1.1.1", 53), timeout=2)',
      '    print("net open")',
      'except OSError:',
      '    print("net blocked")',
    ].join('\n');
    const out = stdout(await run('python', code, 'x'));
    expect(out).toContain('secret False');
    expect(out).toContain('pads hidden');
    expect(out).not.toMatch(/^uid 0$/m);
    if (String((await client.hello).sandbox).startsWith('isolated')) expect(out).toContain('net blocked');
  });

  it('copies attached files next to the program', async () => {
    await fetch(`${srv.url}/proj/helper.py`, { method: 'POST', body: 'def twice(x):\n    return 2 * x\n' });
    await fetch(`${srv.url}/proj/input.txt`, { method: 'POST', body: '21' });
    const events = await run('python', 'from helper import twice\nprint(twice(int(open("input.txt").read())))', 'x', { pad: 'proj' });
    expect(stdout(events)).toBe('42\n');
  });

  it('refuses unknown languages and private attachments', async () => {
    expect(exitOf(await run('cobol', 'DISPLAY "HI"'))).toMatchObject({ type: 'error' });
    const res = await fetch(`${srv.url}/_api/lock`, { method: 'POST', body: JSON.stringify({ path: 'privproj', password: 'pass1234', mode: 'private' }) });
    expect(res.status).toBe(200);
    expect(exitOf(await run('python', 'print(1)', 'x', { pad: 'privproj' }))).toMatchObject({ type: 'error', message: 'This pad is private.' });
  });
});

describe('terminal', () => {
  it('keeps files between commands in the pad workspace', async () => {
    const first = await client.job({ type: 'cmd', pad: 'term/a', language: 'python', code: 'print("from pad")', command: 'echo 7 > n.txt && ls' });
    expect(stdout(first).split('\n')).toEqual(expect.arrayContaining(['main.py', 'n.txt']));
    const second = await client.job({ type: 'cmd', pad: 'term/a', language: 'python', code: 'print("from pad")', command: 'cat n.txt && python3 main.py' });
    expect(stdout(second)).toBe('7\nfrom pad\n');
    // Another pad has its own workspace.
    const other = await client.job({ type: 'cmd', pad: 'term/b', language: 'plaintext', code: '', command: 'ls' });
    expect(stdout(other)).toBe('main.txt\n');
    const reset = await client.job({ type: 'reset', pad: 'term/a' });
    expect(exitOf(reset)).toMatchObject({ type: 'exit', phase: 'reset' });
    const after = await client.job({ type: 'cmd', pad: 'term/a', language: 'python', code: '', command: 'ls' });
    expect(stdout(after)).toBe('main.py\n');
  });

  it('feeds input to a running command', async () => {
    const events = await client.job({ type: 'cmd', pad: 'term/in', language: 'plaintext', code: '', command: 'read x; echo "got $x"' }, (e, send) => {
      if (e.type === 'phase') send({ type: 'stdin', data: 'hello\n' });
    });
    expect(stdout(events)).toBe('got hello\n');
  });

  it('needs edit access', async () => {
    await fetch(`${srv.url}/_api/lock`, { method: 'POST', body: JSON.stringify({ path: 'termlocked', password: 'pass1234', mode: 'readonly' }) });
    const events = await client.job({ type: 'cmd', pad: 'termlocked', language: 'plaintext', code: '', command: 'ls' });
    expect(exitOf(events)).toMatchObject({ type: 'error', code: 'locked' });
  });
});

describe('startup checks', () => {
  it.skipIf(process.getuid?.() !== 0)('refuses a work directory the sandbox user cannot enter', async () => {
    const parent = tempDir('runpad-closed-');
    fs.chmodSync(parent, 0o700);
    await expect(startTestServer({ RUNPAD_WORK: path.join(parent, 'work'), RUNPAD_LANGUAGES: 'python' })).rejects.toThrow(/cannot enter/);
    fs.rmSync(parent, { recursive: true, force: true });
  });
});

describe('run key', () => {
  it('requires the key when one is set', async () => {
    const keyed = await startTestServer({ RUNPAD_EXEC_TOKEN: 's3cret', RUNPAD_LANGUAGES: 'python' });
    const c = new ExecTestClient(keyed.ws);
    expect(await c.hello).toMatchObject({ needsKey: true });
    expect(exitOf(await c.job({ type: 'run', language: 'python', code: 'print(1)', stdin: 'x' }))).toMatchObject({ type: 'error', code: 'key' });
    expect(exitOf(await c.job({ type: 'run', language: 'python', code: 'print(1)', stdin: 'x', key: 'wrong' }))).toMatchObject({ code: 'key' });
    const ok = await c.job({ type: 'run', language: 'python', code: 'print(1)', stdin: 'x', key: 's3cret' });
    expect(stdout(ok)).toBe('1\n');
    c.close();
    await keyed.close();
  });
});

describe('java main class', () => {
  it('finds the class with main, with its package', () => {
    expect(javaMainClass([{ name: 'Main.java', text: 'public class Main { public static void main(String[] a) {} }' }])).toBe('Main');
    expect(javaMainClass([{ name: 'A.java', text: 'package x.y;\nclass Helper {}\npublic class A {\n public static void main(String[] a) {} }' }])).toBe('x.y.A');
    expect(javaMainClass([{ name: 'Util.java', text: 'class Util {}' }, { name: 'App.java', text: 'class App { static void main(String[] a) {} }' }])).toBe('App');
    const nested = 'public class Tree {\n  static class Node { int v; /* class Fake { */ }\n  String s = "class Str {";\n  public static void main(String[] a) {}\n}';
    expect(javaMainClass([{ name: 'Tree.java', text: nested }])).toBe('Tree');
  });
});
