/**
 * Languages RunPad knows about, shared by the server and the editor. Whether a language
 * can be run depends on the toolchains installed on the server (server/languages.js);
 * the rest only get syntax highlighting.
 */

/**
 * @typedef {object} LanguageInfo
 * @property {string} id
 * @property {string} name
 * @property {string[]} ext File extensions, without the dot. The first one is used for new files.
 * @property {string} [template] Starter program shown for an empty pad.
 */

/** @type {LanguageInfo[]} */
export const LANGUAGES = [
  { id: 'plaintext', name: 'Plain text', ext: ['txt', 'text', 'log', 'csv', 'in', 'out'] },
  {
    id: 'python',
    name: 'Python',
    ext: ['py', 'pyw'],
    template: `name = input("What's your name? ")\nprint(f"Hello, {name}!")\n`,
  },
  {
    id: 'c',
    name: 'C',
    ext: ['c', 'h'],
    template: `#include <stdio.h>\n\nint main(void) {\n    char name[64];\n    printf("What's your name? ");\n    if (scanf("%63s", name) == 1)\n        printf("Hello, %s!\\n", name);\n    return 0;\n}\n`,
  },
  {
    id: 'cpp',
    name: 'C++',
    ext: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
    template: `#include <iostream>\n#include <string>\n\nint main() {\n    std::string name;\n    std::cout << "What's your name? ";\n    std::cin >> name;\n    std::cout << "Hello, " << name << "!" << std::endl;\n    return 0;\n}\n`,
  },
  {
    id: 'java',
    name: 'Java',
    ext: ['java'],
    template: `import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        System.out.print("What's your name? ");\n        System.out.flush();\n        String name = in.nextLine();\n        System.out.println("Hello, " + name + "!");\n    }\n}\n`,
  },
  {
    id: 'javascript',
    name: 'JavaScript (Node.js)',
    ext: ['js', 'mjs', 'cjs'],
    template: `const readline = require('node:readline/promises');\n\n(async () => {\n  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });\n  const name = await rl.question("What's your name? ");\n  console.log(\`Hello, \${name}!\`);\n  rl.close();\n})();\n`,
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    ext: ['ts', 'mts'],
    template: `function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n\nconsole.log(greet('world'));\n`,
  },
  {
    id: 'go',
    name: 'Go',
    ext: ['go'],
    template: `package main\n\nimport "fmt"\n\nfunc main() {\n\tvar name string\n\tfmt.Print("What's your name? ")\n\tfmt.Scanln(&name)\n\tfmt.Printf("Hello, %s!\\n", name)\n}\n`,
  },
  {
    id: 'rust',
    name: 'Rust',
    ext: ['rs'],
    template: `use std::io::{self, Write};\n\nfn main() {\n    print!("What's your name? ");\n    io::stdout().flush().unwrap();\n    let mut name = String::new();\n    io::stdin().read_line(&mut name).unwrap();\n    println!("Hello, {}!", name.trim());\n}\n`,
  },
  {
    id: 'ruby',
    name: 'Ruby',
    ext: ['rb'],
    template: `print "What's your name? "\nname = gets&.chomp\nputs "Hello, #{name}!"\n`,
  },
  {
    id: 'php',
    name: 'PHP',
    ext: ['php'],
    template: `<?php\necho "What's your name? ";\n$name = trim(fgets(STDIN));\necho "Hello, $name!\\n";\n`,
  },
  {
    id: 'perl',
    name: 'Perl',
    ext: ['pl', 'pm'],
    template: `use strict;\nuse warnings;\n\nprint "What's your name? ";\nmy $name = <STDIN>;\nchomp $name;\nprint "Hello, $name!\\n";\n`,
  },
  {
    id: 'lua',
    name: 'Lua',
    ext: ['lua'],
    template: `io.write("What's your name? ")\nlocal name = io.read()\nprint("Hello, " .. name .. "!")\n`,
  },
  {
    id: 'bash',
    name: 'Bash',
    ext: ['sh', 'bash'],
    template: `#!/usr/bin/env bash\necho -n "What's your name? "\nread -r name\necho "Hello, $name!"\n`,
  },
  { id: 'markdown', name: 'Markdown', ext: ['md', 'markdown'] },
  {
    id: 'html',
    name: 'HTML',
    ext: ['html', 'htm'],
    template: `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>Hello</title>\n  <style>\n    body { font-family: system-ui, sans-serif; margin: 2rem; }\n  </style>\n</head>\n<body>\n  <h1>Hello!</h1>\n  <button onclick="this.textContent = 'Clicked ' + (++window.n || (window.n = 1)) + ' times'">Click me</button>\n</body>\n</html>\n`,
  },
  { id: 'css', name: 'CSS', ext: ['css'] },
  { id: 'json', name: 'JSON', ext: ['json'] },
  { id: 'sql', name: 'SQL', ext: ['sql'] },
];

export const LANGUAGE_BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

const BY_EXT = new Map();
for (const lang of LANGUAGES) for (const e of lang.ext) if (!BY_EXT.has(e)) BY_EXT.set(e, lang.id);

/** Language for a file name from its extension, or null. */
export function languageFromName(name) {
  const m = /\.([A-Za-z0-9+_-]+)$/.exec(name || '');
  if (m) return BY_EXT.get(m[1].toLowerCase()) ?? null;
  if (/^makefile$/i.test(name || '')) return 'bash';
  return null;
}

/**
 * Guesses the language of a piece of code. Cheap heuristics over the first few KB;
 * returns 'plaintext' when nothing matches well.
 * @param {string} text
 * @returns {string}
 */
export function detectLanguage(text) {
  const t = (text || '').slice(0, 6000);
  if (!t.trim()) return 'plaintext';
  const first = t.trimStart().split('\n', 1)[0];
  if (first.startsWith('#!')) {
    if (/python/.test(first)) return 'python';
    if (/node/.test(first)) return 'javascript';
    if (/ruby/.test(first)) return 'ruby';
    if (/perl/.test(first)) return 'perl';
    if (/php/.test(first)) return 'php';
    if (/lua/.test(first)) return 'lua';
    if (/(ba|z|da)?sh\b/.test(first)) return 'bash';
  }
  if (/^\s*<\?php/.test(t)) return 'php';
  if (/^\s*(<!doctype html|<html[\s>])/i.test(t)) return 'html';
  if (/^\s*package\s+main\b/m.test(t) && /\bfunc\s+\w+\s*\(/.test(t)) return 'go';
  if (/\bfn\s+main\s*\(\s*\)/.test(t) || /\blet\s+mut\s+\w/.test(t) || /\bprintln!\s*\(/.test(t)) return 'rust';
  if (/\b(public|private|protected)?\s*(final\s+)?class\s+\w+/.test(t) && /\b(System\.out|public\s+static\s+void\s+main|import\s+java\.)/.test(t)) return 'java';
  if (/^\s*#\s*include\s*[<"]/m.test(t) || /\bint\s+main\s*\(/.test(t)) {
    if (/#\s*include\s*<(iostream|vector|string|map|set|algorithm|bits\/stdc\+\+\.h|queue|stack|unordered_map)>/.test(t) || /\bstd::|\busing\s+namespace\s+std\b|\bcout\s*<<|\bcin\s*>>|\btemplate\s*</.test(t)) return 'cpp';
    return 'c';
  }
  if (/^\s*(def|class)\s+\w+.*:\s*$/m.test(t) || /^\s*(import\s+\w+|from\s+[\w.]+\s+import\b)/m.test(t) || /\bprint\s*\(\s*f?["']/.test(t) || /\binput\s*\(/.test(t) || /^\s*(elif|except)\b/m.test(t)) return 'python';
  if (/^\s*(const|let|var)\s+\w+\s*=/m.test(t) || /\bconsole\.log\s*\(/.test(t) || /\brequire\s*\(['"]/.test(t) || /=>\s*[{(]/.test(t)) {
    if (/:\s*(string|number|boolean|void|any)\b/.test(t) || /^\s*(interface|type)\s+\w+/m.test(t)) return 'typescript';
    return 'javascript';
  }
  if (/^\s*(puts|require\s+['"]|def\s+\w+\s*$|end\s*$)/m.test(t) && /\bend\b/.test(t)) return 'ruby';
  if (/^\s*use\s+strict;/m.test(t) || /\bmy\s+[$@%]\w+/.test(t)) return 'perl';
  if (/^\s*local\s+\w+\s*=/m.test(t) || /\bio\.write\s*\(/.test(t)) return 'lua';
  if (/^\s*(echo|read|if\s+\[|for\s+\w+\s+in|export\s+\w+=)/m.test(t) && /\b(fi|done|echo)\b/.test(t)) return 'bash';
  if (/^\s*(select|insert\s+into|create\s+table|update\s+\w+\s+set)\b/im.test(t)) return 'sql';
  if (/^\s*[{[]/.test(t)) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      /* not JSON */
    }
  }
  if (/^#{1,6}\s+\S/m.test(t) && /(^\s*[-*]\s+\S|\[.+\]\(.+\)|^```|\*\*\S)/m.test(t)) return 'markdown';
  return 'plaintext';
}

/**
 * The language a pad is shown and run in: an explicit choice wins, then the pad's file
 * extension, then a guess from the content.
 * @param {string | undefined} chosen 'auto' or a language id
 * @param {string} name Last segment of the pad path
 * @param {string} text
 */
export function effectiveLanguage(chosen, name, text) {
  if (chosen && chosen !== 'auto' && LANGUAGE_BY_ID.has(chosen)) return chosen;
  return languageFromName(name) ?? detectLanguage(text);
}

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

/**
 * Name a pad's text is saved under when it runs: the pad's own name if it is a safe file
 * name for that language (`prog1.c`), `Foo.java` for a public class Foo, else `main.<ext>`.
 */
export function mainFileName(padName, languageId, code = '') {
  const info = LANGUAGE_BY_ID.get(languageId);
  const ext = info?.ext[0] ?? 'txt';
  if (languageId === 'java') {
    const cls = /\bpublic\s+(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/.exec(code)?.[1];
    if (cls) return `${cls}.java`;
  }
  if (SAFE_NAME.test(padName) && languageFromName(padName) === languageId) return padName;
  return languageId === 'java' ? 'Main.java' : `main.${ext}`;
}
