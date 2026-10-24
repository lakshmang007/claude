import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

/** Each run gets its own user from this range when the server runs as root. */
const DEFAULT_UIDS = '200000-200999';

function optionalId(value) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a numeric uid/gid, got "${value}"`);
  return n;
}

function uidRange(value) {
  if (!value) return null;
  const m = /^(\d+)-(\d+)$/.exec(String(value).trim());
  const lo = m ? Number(m[1]) : NaN;
  const hi = m ? Number(m[2]) : NaN;
  if (!(lo > 0 && hi >= lo && hi - lo < 1_000_000)) throw new Error(`RUNPAD_EXEC_UIDS must look like 200000-200999 (got "${value}")`);
  return [lo, hi];
}

/**
 * Server settings, all from environment variables (see README). Every value has a
 * default that suits a single machine or a lab network.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [argv]
 */
export function loadConfig(env = process.env, argv = process.argv) {
  // Programs never run as root. A root server gives every run a user of its own from
  // RUNPAD_EXEC_UIDS, unless RUNPAD_EXEC_UID names one user for all runs.
  const uid = optionalId(env.RUNPAD_EXEC_UID);
  const isRoot = process.getuid?.() === 0;
  const uids = uid === null ? uidRange(env.RUNPAD_EXEC_UIDS ?? (isRoot ? DEFAULT_UIDS : '')) : null;
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dev: argv.includes('--dev'),
    dataDir: path.resolve(env.RUNPAD_DATA || path.join(ROOT, 'data')),
    workDir: path.resolve(env.RUNPAD_WORK || path.join(os.tmpdir(), 'runpad')),
    trustProxy: env.RUNPAD_TRUST_PROXY === '1',
    /** Longest pad, in characters. */
    maxPadChars: num(env.RUNPAD_MAX_PAD_KB, 1024) * 1024,
    /** All pads together (approximately); once reached, pads can shrink but not grow. */
    maxTotalChars: num(env.RUNPAD_MAX_STORAGE_MB, 2048) * 1024 * 1024,
    /** Changes over HTTP (saves, locks, uploads) per client IP per minute. */
    writesPerMinute: num(env.RUNPAD_WRITES_PER_MINUTE, 120),
    /** Open WebSockets (editors and runs) per client IP. */
    maxSocketsPerIp: num(env.RUNPAD_MAX_SOCKETS_PER_IP, 40),
    /** Token that opens every pad and lock, for removing abuse. At least 16 characters. */
    adminToken: env.RUNPAD_ADMIN_TOKEN || '',
    /** Shown on the home page and in the menu for reporting abuse (an e-mail address or URL). */
    contact: env.RUNPAD_CONTACT || '',
    history: {
      intervalMs: num(env.RUNPAD_SNAPSHOT_SECONDS, 120) * 1000,
      maxEntries: num(env.RUNPAD_HISTORY_ENTRIES, 50),
      maxBytes: num(env.RUNPAD_HISTORY_MB, 8) * 1024 * 1024,
    },
    exec: {
      enabled: env.RUNPAD_EXEC !== 'off',
      terminal: env.RUNPAD_EXEC !== 'off' && env.RUNPAD_TERMINAL !== 'off',
      /** When set, running code or commands needs this key (entered once per browser). */
      token: env.RUNPAD_EXEC_TOKEN || '',
      /** auto: isolate with unshare when it works; unshare: require it; none: plain processes. */
      sandbox: env.RUNPAD_SANDBOX || 'auto',
      uid,
      gid: optionalId(env.RUNPAD_EXEC_GID) ?? uid,
      /** [first, last] user id for runs, one per run; null to use `uid` for all. */
      uids,
      /** auto: block programs' network with iptables when namespaces are unavailable; require; off. */
      firewall: env.RUNPAD_FIREWALL || 'auto',
      compileTimeoutMs: num(env.RUNPAD_COMPILE_TIMEOUT, 30) * 1000,
      runTimeoutMs: num(env.RUNPAD_RUN_TIMEOUT, 15) * 1000,
      /** Wall-clock limit while a program waits for typed input, or a terminal command runs. */
      interactiveTimeoutMs: num(env.RUNPAD_INTERACTIVE_TIMEOUT, 300) * 1000,
      cpuSeconds: num(env.RUNPAD_CPU_SECONDS, 10),
      memoryMb: num(env.RUNPAD_MEMORY_MB, 512),
      fileSizeMb: num(env.RUNPAD_FILE_MB, 16),
      maxProcesses: num(env.RUNPAD_MAX_PROCS, 128),
      maxOutputBytes: num(env.RUNPAD_MAX_OUTPUT_KB, 512) * 1024,
      maxConcurrent: num(env.RUNPAD_MAX_CONCURRENT, 6),
      maxPerClient: num(env.RUNPAD_MAX_PER_CLIENT, 2),
      runsPerMinute: num(env.RUNPAD_RUNS_PER_MINUTE, 40),
      workspaceMb: num(env.RUNPAD_WORKSPACE_MB, 64),
      workspaceIdleHours: num(env.RUNPAD_WORKSPACE_IDLE_HOURS, 24),
    },
  };
}

/** @typedef {ReturnType<typeof loadConfig>} Config */
