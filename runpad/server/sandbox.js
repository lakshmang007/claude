import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { which } from './languages.js';

/**
 * Runs untrusted programs with limits:
 * - CPU time, file size, core dumps and (where safe) address space via `ulimit`;
 * - a process limit when programs run as their own user (RUNPAD_EXEC_UID);
 * - wall-clock timeout and output cap, enforced here;
 * - its own process group, killed as a whole when the job ends or is stopped;
 * - a clean environment (no server secrets) with HOME and TMPDIR in the job directory.
 *
 * With isolation (`unshare`, used automatically when the kernel allows it) each job also
 * gets its own network namespace (no network access) and PID namespace (cannot see or
 * signal other processes; everything it started dies with it).
 */

const BASE_FLAGS = ['--map-root-user', '--net', '--pid', '--fork', '--kill-child'];
// With a mount namespace, programs get their own /proc (they cannot look at other
// people's running programs) and RunPad's data directory is covered up.
const MOUNT_FLAGS = ['--mount', '--mount-proc'];

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const SIGNAL_NAMES = Object.fromEntries(Object.entries(os.constants.signals).map(([name, num]) => [num, name]));
// Signals that end a program abnormally; with isolation they arrive as exit code 128 + n.
const FATAL = new Set([4, 6, 7, 8, 9, 11, 13, 15, 24, 25, 31]);

/**
 * @typedef {object} JobResult
 * @property {number | null} code
 * @property {string | null} signal
 * @property {null | 'timeout' | 'killed' | 'output' | 'cpu' | 'filesize' | 'spawn'} reason
 * @property {number} timeMs
 * @property {string} [error]
 */

export class Job extends EventEmitter {
  constructor() {
    super();
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    /** @type {JobResult['reason']} */
    this.reason = null;
    this.finished = false;
    /** @type {Promise<JobResult>} */
    this.done = new Promise((resolve) => (this.resolve = resolve));
  }

  /** Sends text to the program's standard input. */
  write(text) {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(text);
  }

  /** Closes standard input (end of file). */
  end() {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed) stdin.end();
  }

  /** Stops the program and everything it started. */
  kill(reason = 'killed') {
    if (this.finished) return;
    if (!this.reason) this.reason = reason;
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        this.child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

export class Sandbox {
  /**
   * @param {{ sandbox: string, uid: number | null, gid: number | null, maxProcesses: number, hide?: string[] }} opts
   *   `hide`: directories programs must not see (RunPad's data); covered with an empty
   *   tmpfs when a mount namespace is available.
   */
  constructor(opts) {
    this.mode = opts.sandbox;
    this.uid = opts.uid;
    this.gid = opts.gid;
    this.maxProcesses = opts.maxProcesses;
    this.hide = opts.hide ?? [];
    /** @type {string[] | null} */
    this.isolation = null;
    this.mounts = false;
    this.unshare = which('unshare');
    this.mount = which('mount');
  }

  #probe(flags, script) {
    const r = spawnSync(this.unshare, [...flags, '/bin/sh', '-c', script], {
      timeout: 5000,
      stdio: 'ignore',
      ...(this.uid !== null ? { uid: this.uid, gid: this.gid ?? this.uid } : {}),
    });
    return r.status === 7;
  }

  /** The commands that cover up hidden directories inside a mount namespace. */
  #hideScript() {
    // A directory the program cannot even reach (say, under a 0700 parent) needs no cover.
    return this.hide.map((dir) => `{ [ ! -e ${quote(dir)} ] || ${quote(this.mount)} -t tmpfs -o size=16k,mode=0755 runpad-hidden ${quote(dir)}; }`).join(' && ');
  }

  /** Works out whether `unshare` isolation is available. */
  init() {
    if (this.mode === 'none') return this;
    if (!['auto', 'unshare'].includes(this.mode)) throw new Error(`RUNPAD_SANDBOX must be auto, unshare or none (got "${this.mode}")`);
    if (this.unshare) {
      const hide = this.#hideScript();
      // A mount namespace counts only if the hidden directories really end up empty.
      const check = this.hide.map((dir) => `[ -z "$(ls -A ${quote(dir)})" ]`).join(' && ');
      if (this.mount && this.#probe([...BASE_FLAGS, ...MOUNT_FLAGS], hide ? `${hide} && ${check} && exit 7` : 'exit 7')) {
        this.isolation = [...BASE_FLAGS, ...MOUNT_FLAGS];
        this.mounts = true;
      } else if (this.#probe(BASE_FLAGS, 'exit 7')) {
        this.isolation = BASE_FLAGS;
      }
    }
    if (!this.isolation && this.mode === 'unshare') {
      throw new Error('RUNPAD_SANDBOX=unshare but `unshare` cannot create user/network/PID namespaces here');
    }
    return this;
  }

  /** Short description for logs and the client. */
  describe() {
    const parts = [this.isolation ? `isolated (no network, own ${this.mounts ? 'PID namespace and /proc' : 'PID namespace'})` : 'plain processes'];
    if (this.uid !== null) parts.push(`uid ${this.uid}`);
    return parts.join(', ');
  }

  /**
   * Starts a program.
   * @param {object} o
   * @param {string[]} o.argv
   * @param {string} o.cwd
   * @param {Record<string, string>} [o.env] added to the clean environment
   * @param {number} o.timeoutMs
   * @param {number} o.cpuSeconds
   * @param {number | null} o.memoryMb
   * @param {number} o.fileSizeMb
   * @param {number} o.maxOutputBytes
   * @param {string | null} [o.stdin] written then closed; null keeps stdin open for typing
   * @param {(stream: 'stdout' | 'stderr', text: string) => void} o.onOutput
   * @returns {Job}
   */
  spawn(o) {
    const job = new Job();
    const cpu = Math.max(1, Math.ceil(o.cpuSeconds));
    // The soft CPU limit sends SIGXCPU (reported as "CPU time limit exceeded"); the hard
    // limit a second later is the backstop.
    const limits = ['ulimit -c 0', `ulimit -H -t ${cpu + 1}`, `ulimit -S -t ${cpu}`, `ulimit -f ${Math.ceil((o.fileSizeMb * 1024 * 1024) / 512)}`];
    if (o.memoryMb) limits.push(`ulimit -v ${Math.ceil(o.memoryMb * 1024)}`);
    if (this.uid !== null && this.maxProcesses) limits.push(`ulimit -u ${this.maxProcesses}`);
    // As PID 1 of its namespace the shell must outlive the program, or signals that end
    // it would be lost; it passes the status on as 128 + signal.
    let script = `${limits.join(' 2>/dev/null; ')} 2>/dev/null; ${this.isolation ? '"$@"; exit $?' : 'exec "$@"'}`;
    // Fail closed: if the data directory cannot be covered up, nothing runs.
    if (this.mounts && this.hide.length) script = `${this.#hideScript()} || { echo 'RunPad sandbox setup failed' >&2; exit 125; }; ${script}`;
    const argv = [...(this.isolation ? [this.unshare, ...this.isolation] : []), '/bin/sh', '-c', script, 'runpad', ...o.argv];

    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: o.cwd,
      TMPDIR: o.cwd,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TERM: 'dumb',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      ...o.env,
    };

    const started = performance.now();
    let outBytes = 0;
    /** @type {Array<[ 'stdout' | 'stderr', string ]>} */
    let pending = [];
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      const chunks = pending;
      pending = [];
      for (const [stream, text] of chunks) o.onOutput(stream, text);
    };
    const push = (stream, text) => {
      if (!text) return;
      const last = pending.at(-1);
      if (last && last[0] === stream) last[1] += text;
      else pending.push([stream, text]);
      if (!flushTimer) flushTimer = setTimeout(flush, 20);
    };

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: o.cwd,
        env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.uid !== null ? { uid: this.uid, gid: this.gid ?? this.uid } : {}),
      });
    } catch (err) {
      job.finished = true;
      job.resolve({ code: null, signal: null, reason: 'spawn', timeMs: 0, error: err.message });
      return job;
    }
    job.child = child;
    child.stdin.on('error', () => {});

    for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
      const decoder = new StringDecoder('utf8');
      child[stream].on('data', (buf) => {
        if (job.reason === 'output') return;
        const room = o.maxOutputBytes - outBytes;
        outBytes += buf.length;
        if (buf.length > room) {
          push(stream, decoder.write(buf.subarray(0, Math.max(0, room))));
          job.kill('output');
          return;
        }
        push(stream, decoder.write(buf));
      });
      child[stream].on('end', () => push(stream, decoder.end()));
    }

    const timer = setTimeout(() => job.kill('timeout'), o.timeoutMs);

    let spawnError = null;
    let exited = null;
    const finish = () => {
      if (job.finished) return;
      clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      job.finished = true;
      const [code, signal] = exited ?? [null, null];
      let sig = signal;
      let status = code;
      if (this.isolation && code !== null && code > 128 && FATAL.has(code - 128)) {
        sig = SIGNAL_NAMES[code - 128] ?? null;
        status = null;
      }
      let reason = job.reason;
      if (!reason && sig === 'SIGXCPU') reason = 'cpu';
      if (!reason && sig === 'SIGXFSZ') reason = 'filesize';
      if (!reason && spawnError) reason = 'spawn';
      job.resolve({
        code: status,
        signal: sig,
        reason,
        timeMs,
        ...(spawnError ? { error: spawnError.message } : {}),
      });
    };
    let timeMs = 0;
    child.on('error', (err) => {
      spawnError = err;
      if (!child.pid) finish();
    });
    child.on('exit', (code, signal) => {
      timeMs = Math.round(performance.now() - started);
      exited = [code, signal];
      // Anything the program left running in its group goes too. Output still in the
      // pipes is read until they close; a process that escaped the group and holds them
      // open is not waited for.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
      setTimeout(() => {
        if (job.finished) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
      }, 250).unref?.();
    });
    child.on('close', () => {
      if (exited) finish();
    });

    if (typeof o.stdin === 'string') {
      if (o.stdin) child.stdin.write(o.stdin);
      child.stdin.end();
    }
    return job;
  }
}
