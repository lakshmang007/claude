import { describe, expect, it } from 'vitest';
import { toArtifactHtml } from '../../scripts/build-artifact.mjs';
import { proxied } from '../../src/search/client';
import { parseManifest, sampleResults } from '../../src/search/samples';

describe('sample manifest', () => {
  const manifest = {
    samples: [
      {
        id: 'hot-sauce',
        title: 'Hot sauce bottle',
        query: 'ember co smoked habanero hot sauce bottle',
        photo: 'samples/hot-sauce/front.jpg',
        references: [
          { id: 'hot-sauce-back', title: 'Back label', file: 'samples/hot-sauce/back.jpg', hint: 'back', source: 'Sample render' },
          { id: 'odd-hint', title: 'Odd', file: 'samples/hot-sauce/odd.jpg', hint: 'diagonal', source: 'Sample render' },
          { id: 'remote', title: 'Remote', file: 'https://example.com/x.jpg', hint: 'side', source: 'Web' },
          { id: 'rooted', title: 'Rooted', file: '/samples/x.jpg', hint: 'side', source: 'Web' },
        ],
      },
      { id: 'no-photo', title: 'Broken' },
      { id: 'abs-photo', title: 'Absolute', photo: 'https://example.com/front.jpg', references: [] },
    ],
  };

  it('keeps valid samples, normalises hints and drops absolute paths', () => {
    const samples = parseManifest(manifest);
    expect(samples.map((s) => s.id)).toEqual(['hot-sauce']);
    expect(samples[0].references.map((r) => [r.id, r.hint])).toEqual([
      ['hot-sauce-back', 'back'],
      ['odd-hint', 'any'],
    ]);
  });

  it('rejects files that are not a manifest', () => {
    expect(parseManifest(null)).toEqual([]);
    expect(parseManifest('<!doctype html>')).toEqual([]);
    expect(parseManifest({ samples: 'nope' })).toEqual([]);
  });

  it('turns references into search results that point at the bundled files', () => {
    const [result] = sampleResults(parseManifest(manifest)[0]);
    expect(result).toEqual({
      id: 'hot-sauce-back',
      title: 'Back label',
      url: 'samples/hot-sauce/back.jpg',
      thumbnail: 'samples/hot-sauce/back.jpg',
      source: 'Sample render',
      hint: 'back',
    });
  });

  it('loads relative app files directly, never through the image proxy', () => {
    expect(proxied('samples/hot-sauce/back.jpg')).toBe('samples/hot-sauce/back.jpg');
    expect(proxied('./samples/a.png')).toBe('./samples/a.png');
    // Page-relative too, so a build under a sub-path never calls the host's own /api.
    expect(proxied('https://example.com/a.jpg')).toBe('api/image?url=https%3A%2F%2Fexample.com%2Fa.jpg');
    expect(proxied('//example.com/a.jpg')).toMatch(/^api\/image\?url=/);
    // Thumbnails are shown from the copy ranking downloaded, not downloaded again.
    expect(proxied('blob:http://127.0.0.1:5180/0b6c')).toBe('blob:http://127.0.0.1:5180/0b6c');
  });
});

describe('artifact page', () => {
  const built = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>TrueForm 3D</title>
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body>
    <header class="topbar"><img src="./favicon.svg" alt="" /></header>
    <main id="app"></main>
  </body>
</html>`;
  const css = '.a{background:url(./bg.png)}.b{background:url("data:image/png;base64,AA")}';

  it('is a fragment: title, inlined CSS, body markup, then the module script', () => {
    const { html, inlined } = toArtifactHtml(built, (file: string) => {
      expect(file).toBe('assets/index-abc.css');
      return css;
    });
    expect(inlined).toEqual(['assets/index-abc.css']);
    expect(html.startsWith('<title>TrueForm 3D</title>\n<style>\n')).toBe(true);
    expect(html).not.toMatch(/<!doctype|<html[\s>]|<head[\s>]|<\/head>|<body[\s>]|<\/body>|<link\b|crossorigin/i);
    expect(html).toContain('url(assets/bg.png)');
    expect(html).toContain('url("data:image/png;base64,AA")');
    expect(html).toContain('<header class="topbar"><img src="./favicon.svg" alt="" /></header>');
    expect(html.trimEnd().endsWith('<script type="module" src="assets/index-abc.js"></script>')).toBe(true);
  });

  it('refuses builds with absolute asset paths', () => {
    expect(() => toArtifactHtml(built.replace('./assets/index-abc.js', '/assets/index-abc.js'), () => css)).toThrow(/relative/);
    expect(() => toArtifactHtml(built.replace('<main id="app">', '<main id="app"><img src="/logo.svg">'), () => css)).toThrow(/absolute path/);
  });
});
