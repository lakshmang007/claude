#!/usr/bin/env node
// Turns the demo build (dist-demo/) into artifact/: a page for hosts that wrap it in
// their own <!doctype html><head><body> skeleton and allow no external stylesheets.
//
//   node scripts/build-artifact.mjs [--src dist-demo] [--out artifact]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** A built asset path made relative to the page; absolute paths would break hosting under a sub-path. */
function relativeAsset(url) {
  if (/^([a-z][a-z\d+.-]*:|\/)/i.test(url)) throw new Error(`Expected a relative asset path, got "${url}" (build with base './')`);
  return url.replace(/^(\.\/)+/, '');
}

/** CSS url()s are relative to the stylesheet; once inlined they resolve against the page instead. */
function rebaseCssUrls(css, cssDir) {
  if (!cssDir) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, quote, url) =>
    /^([a-z][a-z\d+.-]*:|\/|#)/i.test(url) ? whole : `url(${quote}${path.posix.join(cssDir, url)}${quote})`,
  );
}

/**
 * Rewrites Vite's index.html into a page fragment: the title first, the CSS inlined in a
 * <style>, the body markup, then the module script(s). No doctype/html/head/body tags.
 * `readFile` returns the text of a built file given its path relative to the page.
 */
export function toArtifactHtml(html, readFile) {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1].trim() || 'TrueForm 3D';
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1];
  if (body == null) throw new Error('index.html has no <body>');

  const css = [];
  const inlined = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attributes(m[0].slice(5));
    if (!/\bstylesheet\b/i.test(a.rel ?? '')) continue;
    const file = relativeAsset(a.href ?? '');
    inlined.push(file);
    css.push(rebaseCssUrls(readFile(file), path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)));
  }

  const scripts = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const a = attributes(m[1]);
    if (a.type !== 'module') continue;
    if (a.src) scripts.push(`<script type="module" src="${relativeAsset(a.src)}"></script>`);
    else if (m[2].trim()) scripts.push(`<script type="module">${m[2]}</script>`);
  }
  if (!scripts.length) throw new Error('index.html has no module script');

  const markup = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
  for (const m of markup.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    if (/^\/(?!\/)/.test(m[1])) throw new Error(`Body markup references "${m[1]}" by absolute path`);
  }

  const page = [`<title>${title}</title>`, `<style>\n${css.join('\n').trim()}\n</style>`, markup, ...scripts].join('\n');
  return { html: `${page}\n`, inlined };
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const src = path.resolve(root, option('--src', 'dist-demo'));
  const out = path.resolve(root, option('--out', 'artifact'));
  if (!fs.existsSync(path.join(src, 'index.html'))) {
    console.error(`No demo build in ${path.relative(root, src) || src}. Run "npm run build:demo" first.`);
    process.exit(1);
  }
  const { html, inlined } = toArtifactHtml(fs.readFileSync(path.join(src, 'index.html'), 'utf8'), (file) => fs.readFileSync(path.join(src, file), 'utf8'));

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), html);
  const files = [['index.html', Buffer.byteLength(html)]];
  for (const file of walk(src)) {
    // The ONNX runtime .wasm is only loaded by the AI worker, which is off in the demo.
    if (file === 'index.html' || inlined.includes(file) || file.endsWith('.wasm')) continue;
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(path.join(src, file), path.join(out, file));
    files.push([file, fs.statSync(path.join(out, file)).size]);
  }

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  const width = Math.max(...files.map(([f]) => f.length));
  console.log(`Artifact in ${path.relative(root, out) || out}/:`);
  for (const [file, size] of files) console.log(`  ${file.padEnd(width)}  ${kb(size).padStart(10)}`);
  const total = files.reduce((s, [, size]) => s + size, 0);
  console.log(`${files.length} files, ${(total / 1024 / 1024).toFixed(2)} MB total`);
  checkSamples(out);
}

/** The demo opens with the first sample, so a manifest pointing at missing files is a broken artifact. */
function checkSamples(out) {
  const manifest = path.join(out, 'samples', 'manifest.json');
  if (!fs.existsSync(manifest)) {
    console.warn('Note: no samples/manifest.json in the build, so the demo will open without a model.');
    return;
  }
  const { samples = [] } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const wanted = samples.flatMap((s) => [s.photo, ...(s.references ?? []).map((r) => r.file)]).filter(Boolean);
  const missing = wanted.filter((f) => !fs.existsSync(path.join(out, f)));
  if (missing.length) {
    console.error(`samples/manifest.json references files missing from the build:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`${samples.length} sample(s), ${wanted.length} sample images present.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
