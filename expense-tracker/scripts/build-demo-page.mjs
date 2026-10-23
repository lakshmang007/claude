// Turns the `--mode demo` build into one self-contained HTML fragment (dist-demo/expense-tracker.html):
// the stylesheet and script inlined, no service worker, manifest or icons. It is the online preview,
// published to a host that supplies the <html>, <head> and <body> itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-demo');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/g)].map((m) => m[1]);
if (scripts.length !== 1 || styles.length !== 1) {
  throw new Error(`Expected one script and one stylesheet in dist-demo/index.html, found ${scripts.length} and ${styles.length}.`);
}
const css = readFileSync(join(dist, styles[0]), 'utf8').replace(/<\/style/gi, '<\\/style');
const js = readFileSync(join(dist, scripts[0]), 'utf8').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const page = `<title>Expense Tracker</title>
<meta name="description" content="Track your spending and income. Works offline and installs on your phone.">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`;
writeFileSync(join(dist, 'expense-tracker.html'), page);
console.log(`dist-demo/expense-tracker.html (${Math.round(page.length / 1024)} KB)`);
