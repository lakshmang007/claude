import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

const NOBODY = 65534;

function optionalId(value) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a numeric uid/gid, got "${value}"`);
  return n;
}

/**
 * Server settings, all from environment variables (see README). Every value has a
 * default that suits a single machine or a lab network.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string[]} [argv]
 */
export function loadConfig(env = process.env, argv = process.argv) {
  // Programs never run as root: a root server runs them as `nobody` unless told otherwise.
  const uid = optionalId(env.RUNPAD_EXEC_UID) ?? (process.getuid?.() === 0 ? NOBODY : null);
  return {
    port: num(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dev: argv.includes('--dev'),
    dataDir: path.resolve(env.RUNPAD_DATA || path.join(ROOT, 'data')),
    workDir: path.resolve(env.RUNPAD_WORK || path.join(os.tmpdir(), 'runpad')),
    trustProxy: env.RUNPAD_TRUST_PROXY === '1',
    /** Longest pad, in characters. */
    maxPadChars: num(env.RUNPAD_MAX_PAD_KB, 1024) * 1024,
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
