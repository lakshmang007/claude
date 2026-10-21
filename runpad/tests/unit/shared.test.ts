import { describe, expect, it } from 'vitest';
import { detectLanguage, effectiveLanguage, languageFromName, mainFileName } from '../../shared/langs.js';
import { isAttachableName, isFileName, normalizePadPath, padUrl, parentPath, selfAndAncestors } from '../../shared/padpath.js';
import { replaceText } from '../../shared/ytext.js';
import { ansiClasses, findFileRefs, parseAnsi, plainState } from '../../src/ansi';
import { diffLines } from '../../src/diff';
import * as Y from 'yjs';

describe('pad paths', () => {
  it('normalises URL paths', () => {
    expect(normalizePadPath('/lab/prog1.c')).toBe('lab/prog1.c');
    expect(normalizePadPath('//a///b/')).toBe('a/b');
    expect(normalizePadPath('/caf%C3%A9/n%20otes')).toBe('café/n otes');
    expect(normalizePadPath('/Lab')).toBe('Lab');
  });

  it('rejects the home page, reserved names and traversal', () => {
    expect(normalizePadPath('/')).toBeNull();
    expect(normalizePadPath('')).toBeNull();
    expect(normalizePadPath('/_api/x')).toBeNull();
    expect(normalizePadPath('/favicon.ico')).toBeNull();
    expect(normalizePadPath('/a/../b')).toBeNull();
    expect(normalizePadPath('/a/%2e%2e/b')).toBeNull();
    expect(normalizePadPath('/a%2Fb')).toBeNull();
    expect(normalizePadPath('/a%00b')).toBeNull();
    expect(normalizePadPath('/%E0%A4%A')).toBeNull();
    expect(normalizePadPath('/' + 'x'.repeat(101))).toBeNull();
    expect(normalizePadPath('/' + Array(17).fill('a').join('/'))).toBeNull();
  });

  it('allows `_` below the top level and decoded input', () => {
    expect(normalizePadPath('/a/_b')).toBe('a/_b');
    expect(normalizePadPath('a b/c%d', { decoded: true })).toBe('a b/c%d');
  });

  it('builds URLs and walks ancestors', () => {
    expect(padUrl('café/a b')).toBe('/caf%C3%A9/a%20b');
    expect(padUrl('x/a:b')).toBe('/x/a:b');
    expect(parentPath('a/b/c')).toBe('a/b');
    expect(parentPath('a')).toBeNull();
    expect(selfAndAncestors('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('recognises attachable file names', () => {
    expect(isFileName('util.h')).toBe(true);
    expect(isFileName('input.txt')).toBe(true);
    expect(isFileName('Makefile')).toBe(true);
    expect(isFileName('notes')).toBe(false);
    expect(isFileName('.hidden')).toBe(false);
    expect(isAttachableName('-rf.c')).toBe(false);
  });
});

describe('languages', () => {
  it('maps file names', () => {
    expect(languageFromName('prog1.c')).toBe('c');
    expect(languageFromName('Main.java')).toBe('java');
    expect(languageFromName('x.CPP')).toBe('cpp');
    expect(languageFromName('notes')).toBeNull();
  });

  it.each([
    ['#include <stdio.h>\nint main(){printf("hi");}', 'c'],
    ['#include <iostream>\nint main(){std::cout<<1;}', 'cpp'],
    ['#include <bits/stdc++.h>\nusing namespace std;\nint main(){}', 'cpp'],
    ['public class Main { public static void main(String[] a){ System.out.println(1); } }', 'java'],
    ['n = int(input())\nprint(n * 2)', 'python'],
    ['def f(x):\n    return x\n', 'python'],
    ['const x = 1;\nconsole.log(x);', 'javascript'],
    ['const x: number = 1;\nconsole.log(x);', 'typescript'],
    ['package main\nimport "fmt"\nfunc main() { fmt.Println(1) }', 'go'],
    ['fn main() { println!("hi"); }', 'rust'],
    ['<?php echo 1;', 'php'],
    ['#!/bin/bash\necho hi', 'bash'],
    ['<!doctype html><html><body></body></html>', 'html'],
    ['# Title\n\n- item\n- item', 'markdown'],
    ['{"a": 1}', 'json'],
    ['shopping list: milk, eggs', 'plaintext'],
  ])('detects %#', (code, lang) => {
    expect(detectLanguage(code)).toBe(lang);
  });

  it('prefers an explicit choice, then the extension', () => {
    expect(effectiveLanguage('python', 'x.c', 'int main(){}')).toBe('python');
    expect(effectiveLanguage('auto', 'x.c', 'print(1)')).toBe('c');
    expect(effectiveLanguage(undefined, 'notes', 'print("x")')).toBe('python');
  });

  it('names the main file', () => {
    expect(mainFileName('prog1.c', 'c')).toBe('prog1.c');
    expect(mainFileName('alice', 'c')).toBe('main.c');
    expect(mainFileName('prog1.c', 'cpp')).toBe('main.cpp');
    expect(mainFileName('x', 'java', 'public class Hello { }')).toBe('Hello.java');
    expect(mainFileName('x', 'java', 'class A {}')).toBe('Main.java');
    expect(mainFileName('-o.c', 'c')).toBe('main.c');
  });
});

describe('replaceText', () => {
  it('touches only the changed middle', () => {
    const doc = new Y.Doc();
    const t = doc.getText('t');
    t.insert(0, 'hello brave world');
    const events: unknown[] = [];
    t.observe((e) => events.push(e.delta));
    doc.transact(() => expect(replaceText(t, 'hello new world')).toBe(true));
    expect(t.toString()).toBe('hello new world');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.arrayContaining([{ retain: 6 }, { delete: 5 }, { insert: 'new' }]));
    expect(events[0]).toHaveLength(3);
    expect(replaceText(t, 'hello new world')).toBe(false);
  });

  it('keeps surrogate pairs intact', () => {
    const doc = new Y.Doc();
    const t = doc.getText('t');
    t.insert(0, 'a😀b');
    replaceText(t, 'a😁b');
    expect(t.toString()).toBe('a😁b');
  });
});

describe('ansi', () => {
  it('parses colours across chunks', () => {
    const state = plainState();
    const a = parseAnsi('\x1b[31merr', state);
    expect(a).toEqual([{ text: 'err', state: expect.objectContaining({ fg: 1 }) }]);
    const b = parseAnsi('or\x1b[0m ok\r\n', state);
    expect(b.map((s) => s.text)).toEqual(['or', ' ok\n']);
    expect(ansiClasses(b[0].state)).toBe('ansi-fg-1');
  });

  it('drops cursor movement codes', () => {
    expect(parseAnsi('a\x1b[2Kb\x1b]0;title\x07c', plainState()).map((s) => s.text).join('')).toBe('abc');
  });

  it('finds compiler and runtime file references', () => {
    const known = (f: string) => ['main.c', 'main.py', 'Main.java', 'main.php'].includes(f);
    expect(findFileRefs("main.c:7:12: error: 'x' undeclared", known)).toMatchObject([{ file: 'main.c', line: 7, col: 12 }]);
    expect(findFileRefs('  File "/tmp/x/main.py", line 3, in <module>', known)).toMatchObject([{ file: 'main.py', line: 3 }]);
    expect(findFileRefs('Main.java:5: error: ; expected', known)).toMatchObject([{ file: 'Main.java', line: 5 }]);
    expect(findFileRefs('PHP Parse error: syntax error in main.php on line 4', known)).toMatchObject([{ file: 'main.php', line: 4 }]);
    expect(findFileRefs('other.c:1:1: note', known)).toEqual([]);
  });
});

describe('diffLines', () => {
  const apply = (a: string[], diff: NonNullable<ReturnType<typeof diffLines>>) => {
    expect(diff.filter((l) => l.op !== '+').map((l) => l.text)).toEqual(a);
    return diff.filter((l) => l.op !== '-').map((l) => l.text);
  };

  it('produces a valid edit script', () => {
    const a = ['a', 'b', 'c', 'd', 'e'];
    const b = ['a', 'x', 'c', 'e', 'f'];
    const diff = diffLines(a, b)!;
    expect(apply(a, diff)).toEqual(b);
    expect(diff.filter((l) => l.op !== ' ').length).toBe(4);
  });

  it('handles empty sides and random edits', () => {
    expect(apply([], diffLines([], ['x'])!)).toEqual(['x']);
    expect(apply(['x'], diffLines(['x'], [])!)).toEqual([]);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: Math.floor(rand() * 30) }, () => String(Math.floor(rand() * 5)));
      const b = Array.from({ length: Math.floor(rand() * 30) }, () => String(Math.floor(rand() * 5)));
      expect(apply(a, diffLines(a, b)!)).toEqual(b);
    }
  });

  it('gives up on huge differences', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffLines(a, b, 10)).toBeNull();
  });
});
