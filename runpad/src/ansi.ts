/**
 * Turns program output into DOM nodes: ANSI colour codes become styled spans, other
 * escape sequences are dropped, and `file:line` references become clickable.
 */

export interface AnsiState {
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export const plainState = (): AnsiState => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false });

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]/g;

export interface Segment {
  text: string;
  state: AnsiState;
}

/** Splits text into styled segments, updating `state` across calls (chunks of a stream). */
export function parseAnsi(text: string, state: AnsiState): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  ESC.lastIndex = 0;
  for (let m = ESC.exec(text); m; m = ESC.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), state: { ...state } });
    last = ESC.lastIndex;
    if (m[2] !== 'm') continue;
    const codes = (m[1] || '0').split(';').map((c) => Number(c) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.assign(state, plainState());
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 3) state.italic = true;
      else if (c === 4) state.underline = true;
      else if (c === 22) state.bold = state.dim = false;
      else if (c === 23) state.italic = false;
      else if (c === 24) state.underline = false;
      else if (c >= 30 && c <= 37) state.fg = c - 30;
      else if (c >= 90 && c <= 97) state.fg = c - 90 + 8;
      else if (c === 39) state.fg = null;
      else if (c >= 40 && c <= 47) state.bg = c - 40;
      else if (c >= 100 && c <= 107) state.bg = c - 100 + 8;
      else if (c === 49) state.bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const n = codes[i + 2] ?? 0;
        if (c === 38) state.fg = n < 16 ? n : null;
        else state.bg = n < 16 ? n : null;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) i += 4;
    }
  }
  if (last < text.length) out.push({ text: text.slice(last), state: { ...state } });
  // Carriage returns that are not part of \r\n would overwrite the line in a terminal;
  // here they are dropped so progress bars stay readable.
  for (const seg of out) seg.text = seg.text.replace(/\r(?!\n)/g, '').replace(/\r\n/g, '\n');
  return out.filter((s) => s.text);
}

export function isPlain(s: AnsiState): boolean {
  return s.fg === null && s.bg === null && !s.bold && !s.dim && !s.italic && !s.underline;
}

export function ansiClasses(s: AnsiState): string {
  const cls: string[] = [];
  if (s.fg !== null) cls.push(`ansi-fg-${s.fg}`);
  if (s.bg !== null) cls.push(`ansi-bg-${s.bg}`);
  if (s.bold) cls.push('ansi-bold');
  if (s.dim) cls.push('ansi-dim');
  if (s.italic) cls.push('ansi-italic');
  if (s.underline) cls.push('ansi-underline');
  return cls.join(' ');
}

export interface FileRef {
  file: string;
  line: number;
  col?: number;
  start: number;
  end: number;
}

// gcc/clang/javac/go/rustc: "main.c:12:5", "Main.java:3", "--> main.rs:4:9"; Python:
// 'File "main.py", line 3'; Node: "main.js:7:11"; Ruby "main.rb:2:in"; PHP "main.php on line 4".
const REF = /\b([\w.+-]+\.[A-Za-z]{1,6}):(\d+)(?::(\d+))?|File "(?:\.\/)?([^"]+)", line (\d+)|\b([\w.+-]+\.php) on line (\d+)/g;

/** Finds references to source lines in compiler or runtime messages. */
export function findFileRefs(text: string, known: (file: string) => boolean): FileRef[] {
  const refs: FileRef[] = [];
  REF.lastIndex = 0;
  for (let m = REF.exec(text); m; m = REF.exec(text)) {
    const file = (m[1] ?? m[4] ?? m[6] ?? '').replace(/^.*\//, '');
    const line = Number(m[2] ?? m[5] ?? m[7]);
    if (!file || !line || !known(file)) continue;
    refs.push({ file, line, col: m[3] ? Number(m[3]) : undefined, start: m.index, end: m.index + m[0].length });
  }
  return refs;
}
