import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAttachableName } from '../shared/padpath.js';
import { LANGUAGE_BY_ID, mainFileName } from '../shared/langs.js';
import { ROOT } from './config.js';

/**
 * How each language is compiled and run. Only languages whose toolchain is installed on
 * the server are offered; detectToolchains() finds them at startup.
 *
 * A plan's commands run in a directory holding the pad as `main` (see mainFileName) plus
 * the pad's attached files. Interpreted languages are told not to buffer output, so
 * prompts show up before the program waits for input.
 */

/** Files that make Ruby and Perl flush output as they print. */
export const HELPER_SOURCE = path.join(ROOT, 'server', 'helpers');
// Where programs load them from; ExecServer copies them somewhere the sandbox user can read.
export let HELPERS = HELPER_SOURCE;

export function useHelpersDir(dir) {
  HELPERS = dir;
}

export { isAttachableName, mainFileName };

function withExt(files, exts) {
  return files.filter((f) => exts.some((e) => f.toLowerCase().endsWith('.' + e)));
}

/** Blanks out comments and string literals, keeping positions, so braces can be matched. */
function stripJava(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Java class to start: the innermost class whose body holds `main`, package-qualified. */
export function javaMainClass(sources) {
  for (const { name, text } of sources) {
    const src = stripJava(text);
    const mainAt = src.search(/\bvoid\s+main\s*\(/);
    if (mainAt < 0) continue;
    let cls = null;
    let clsStart = -1;
    for (const m of src.matchAll(/\b(?:class|record|enum|interface)\s+([A-Za-z_]\w*)/g)) {
      const open = src.indexOf('{', m.index);
      if (open < 0 || open > mainAt) continue;
      let depth = 0;
      let close = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) {
          close = i;
          break;
        }
      }
      if ((close < 0 || close > mainAt) && m.index > clsStart) {
        cls = m[1];
        clsStart = m.index;
      }
    }
    cls ??= name.replace(/\.java$/, '');
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(src)?.[1];
    return pkg ? `${pkg}.${cls}` : cls;
  }
  return sources[0]?.name.replace(/\.java$/, '') ?? 'Main';
}

/**
 * @typedef {object} Plan
 * @property {string[]} [compile]
 * @property {string[]} run
 * @property {boolean} memoryLimit Whether `ulimit -v` is safe (not for JVM, V8 or Go).
 * @property {Record<string, string>} [env]
 *
 * @typedef {object} PlanInput
 * @property {string} main Main file name.
 * @property {string[]} files All file names in the directory, main included.
 * @property {(name: string) => string} read Text of a file.
 */

/**
 * @typedef {object} Runner
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {(input: PlanInput) => Plan} plan
 */

/** @param {Record<string, string>} bin absolute paths of the tools found */
function definitions(bin, extra) {
  const unbuffered = (argv) => (bin.stdbuf ? [bin.stdbuf, '-o0', '-e0', ...argv] : argv);
  return {
    python: {
      need: ['python3'],
      version: [bin.python3, '--version'],
      plan: ({ main }) => ({ run: [bin.python3, '-u', main], memoryLimit: true }),
    },
    c: {
      need: ['gcc'],
      version: [bin.gcc, '-dumpfullversion'],
      versionPrefix: 'gcc ',
      plan: ({ main, files }) => ({
        compile: [bin.gcc, '-O2', '-std=gnu17', '-Wall', '-fdiagnostics-color=never', '-o', 'main', main, ...withExt(files, ['c']).filter((f) => f !== main), '-lm'],
        run: unbuffered(['./main']),
        memoryLimit: true,
      }),
    },
    cpp: {
      need: ['g++'],
      version: [bin['g++'], '-dumpfullversion'],
      versionPrefix: 'g++ ',
      plan: ({ main, files }) => ({
        compile: [bin['g++'], '-O2', '-std=gnu++17', '-Wall', '-fdiagnostics-color=never', '-o', 'main', main, ...withExt(files, ['cpp', 'cc', 'cxx']).filter((f) => f !== main)],
        run: unbuffered(['./main']),
        memoryLimit: true,
      }),
    },
    java: {
      need: ['javac', 'java'],
      version: [bin.java, '-version'],
      plan: ({ main, files, read }) => {
        const sources = [main, ...withExt(files, ['java']).filter((f) => f !== main)];
        return {
          compile: [bin.javac, '-J-Xshare:auto', '-encoding', 'UTF-8', '-d', '.', ...sources],
          run: [bin.java, '-Xmx256m', '-Xss16m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-XX:-UsePerfData', '-Dfile.encoding=UTF-8', '-cp', '.', javaMainClass(sources.map((name) => ({ name, text: read(name) })))],
          memoryLimit: false,
        };
      },
    },
    javascript: {
      need: ['node'],
      version: [bin.node, '--version'],
      versionPrefix: 'Node.js ',
      plan: ({ main }) => ({ run: [bin.node, '--max-old-space-size=256', main], memoryLimit: false }),
    },
    typescript: {
      need: ['node'],
      available: () => extra.nodeStripTypes,
      version: [bin.node, '--version'],
      versionPrefix: 'Node.js ',
      plan: ({ main }) => ({ run: [bin.node, '--experimental-strip-types', '--no-warnings', '--max-old-space-size=256', main], memoryLimit: false }),
    },
    go: {
      need: ['go'],
      version: [bin.go, 'version'],
      plan: ({ main, files }) => ({
        compile: [bin.go, 'build', '-o', 'main', main, ...withExt(files, ['go']).filter((f) => f !== main && !f.endsWith('_test.go'))],
        run: ['./main'],
        memoryLimit: false,
        env: { GOMEMLIMIT: '256MiB' },
      }),
    },
    rust: {
      need: ['rustc'],
      version: [extra.rustc ?? bin.rustc, '--version'],
      plan: ({ main }) => ({ compile: [extra.rustc ?? bin.rustc, '-O', '--edition=2021', '-o', 'main', main], run: ['./main'], memoryLimit: true }),
    },
    ruby: {
      need: ['ruby'],
      version: [bin.ruby, '--version'],
      plan: ({ main }) => ({ run: [bin.ruby, `-r${path.join(HELPERS, 'rp_sync.rb')}`, main], memoryLimit: true }),
    },
    php: {
      need: ['php'],
      version: [bin.php, '--version'],
      plan: ({ main }) => ({ run: [bin.php, '-d', 'display_errors=stderr', main], memoryLimit: true }),
    },
    perl: {
      need: ['perl'],
      version: [bin.perl, '-e', 'print "Perl $^V\\n"'],
      plan: ({ main }) => ({ run: [bin.perl, `-I${HELPERS}`, '-MRunPadSync', main], memoryLimit: true }),
    },
    lua: {
      need: ['lua'],
      version: [bin.lua, '-v'],
      plan: ({ main }) => ({ run: unbuffered([bin.lua, main]), memoryLimit: true }),
    },
    bash: {
      need: ['bash'],
      version: [bin.bash, '--version'],
      plan: ({ main }) => ({ run: [bin.bash, main], memoryLimit: true }),
    },
  };
}

/** Finds an executable on PATH. */
export function which(name, envPath = process.env.PATH ?? '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** @type {{ uid?: number, gid?: number }} */
let probeUser = {};

function run(argv, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout, encoding: 'utf8', cwd: os.tmpdir(), ...probeUser }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    );
  });
}

const TOOLS = ['python3', 'gcc', 'g++', 'javac', 'java', 'node', 'go', 'rustc', 'ruby', 'php', 'perl', 'lua', 'bash', 'stdbuf'];
const LUA_NAMES = ['lua', 'lua5.4', 'lua5.3', 'luajit'];

/**
 * Detects installed toolchains. Each is tried as the user programs run as, so tools that
 * user cannot reach (say, under root's home directory) are left out.
 * @param {{ only?: string[], uid?: number | null, gid?: number | null }} [opts] `only`: limit to these language ids (RUNPAD_LANGUAGES)
 * @returns {Promise<Map<string, Runner>>}
 */
export async function detectToolchains(opts = {}) {
  probeUser = opts.uid !== null && opts.uid !== undefined ? { uid: opts.uid, gid: opts.gid ?? opts.uid } : {};
  /** @type {Record<string, string>} */
  const bin = {};
  for (const tool of TOOLS) {
    const found = tool === 'lua' ? LUA_NAMES.map((n) => which(n)).find(Boolean) : tool === 'node' ? process.execPath : which(tool);
    if (found) bin[tool] = found;
  }
  const extra = { nodeStripTypes: false, rustc: null };
  const probes = [];
  if (bin.node) {
    const probe = path.join(os.tmpdir(), `runpad-ts-probe-${process.pid}.ts`);
    fs.writeFileSync(probe, 'const n: string = "ok"; console.log(n);\n', { mode: 0o644 });
    probes.push(
      run([bin.node, '--experimental-strip-types', '--no-warnings', probe]).then((r) => {
        extra.nodeStripTypes = r.ok && r.out === 'ok';
        fs.rmSync(probe, { force: true });
      }),
    );
  }
  if (bin.rustc) {
    // rustup's proxy needs the server user's home directory; call the real compiler.
    probes.push(
      run([bin.rustc, '--print', 'sysroot']).then((r) => {
        const real = r.ok ? path.join(r.out.split('\n').pop(), 'bin', 'rustc') : null;
        if (real && fs.existsSync(real)) extra.rustc = real;
      }),
    );
  }
  await Promise.all(probes);

  const defs = definitions(bin, extra);
  /** @type {Map<string, Runner>} */
  const runners = new Map();
  await Promise.all(
    Object.entries(defs).map(async ([id, def]) => {
      if (opts.only && !opts.only.includes(id)) return;
      if (!def.need.every((t) => bin[t])) return;
      if (def.available && !def.available()) return;
      const v = await run(def.version);
      if (!v.ok) return;
      const line = v.out.split('\n').find((l) => l.trim() && !l.startsWith('Picked up')) ?? '';
      runners.set(id, { id, name: LANGUAGE_BY_ID.get(id)?.name ?? id, version: ((def.versionPrefix ?? '') + line).trim().slice(0, 80), plan: def.plan });
    }),
  );
  return new Map([...LANGUAGE_BY_ID.keys()].filter((id) => runners.has(id)).map((id) => [id, runners.get(id)]));
}

/** Shell for terminal commands. */
export function terminalShell() {
  return which('bash') ?? '/bin/sh';
}
