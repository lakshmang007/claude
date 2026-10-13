import './styles.css';
import { createByte, cropRGBA, maskBBox, padRect, resizeByte } from './core/imageops';
import { limitSize } from './core/reconstruct';
import type { ReconstructWorkerIn, ReconstructWorkerOut } from './core/reconstruct.worker';
import { alphaMask, hasUsefulAlpha, refineMatte, segmentByColor } from './core/segment';
import {
  DEFAULT_SETTINGS,
  VIEW_NAMES,
  type ByteField,
  type FloatField,
  type MeshResult,
  type ReconstructInput,
  type ReconstructSettings,
  type RGBAImage,
  type ViewInput,
  type ViewName,
} from './core/types';
import { download, exportGLB, exportOBJZip, exportSTL, exportUSDZ } from './export/exporters';
import { MLClient } from './ml/client';
import { DEFAULT_MODELS, type MLProgress } from './ml/protocol';
import { apiHealth, browserSearchLinks, proxied, searchReferences, type SearchResult } from './search/client';
import { LABELS, PROMPT, queryFromFilename, topLabels } from './search/identify';
import { autoAssign, CANDIDATE_VIEWS, scoreWithClip, scoreWithColor, viewPrompts, type CandidateView, type Scored } from './search/rank';
import { blobToRGBA, drawPreview, readDataTransfer, rgbaToCanvas, urlToRGBA, type DroppedImage } from './ui/imageio';
import { Viewer, type Shading } from './viewer/viewer';

// ---------------------------------------------------------------------------
// State

type CutoutMode = 'auto' | 'ai' | 'color' | 'alpha' | 'none';

interface Photo {
  name: string;
  source: string;
  image: RGBAImage;
  mask?: ByteField;
  maskKey?: string;
  maskMethod?: string;
  depth?: FloatField;
  depthRect?: ViewInput['depthRect'];
  depthKey?: string;
}

interface RefSlot extends Photo {
  flip: boolean;
  resultId?: string;
}

interface Candidate {
  result: SearchResult;
  thumb?: RGBAImage;
  score?: Scored;
  failed?: boolean;
}

const FRONT_MAX = 2048;
const REF_MAX = 1024;

const state = {
  front: null as Photo | null,
  refs: { back: null, left: null, right: null, top: null } as Record<ViewName, RefSlot | null>,
  candidates: [] as Candidate[],
  rankMode: null as 'clip' | 'color' | null,
  label: '' as string,
  settings: loadSettings(),
  ai: loadAiPrefs(),
  aiFailed: new Set<string>(),
  busy: false,
  dirty: false,
  result: null as MeshResult | null,
  atlasCanvas: null as HTMLCanvasElement | null,
  clipLabelVecs: null as Float32Array[] | null,
  frontEmbedding: null as Float32Array | null,
  generation: 0,
};

function loadSettings(): ReconstructSettings {
  try {
    const raw = localStorage.getItem('trueform.settings');
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // storage unavailable
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  try {
    localStorage.setItem('trueform.settings', JSON.stringify(state.settings));
    localStorage.setItem('trueform.ai', JSON.stringify(state.ai));
  } catch {
    // storage unavailable
  }
}

function loadAiPrefs() {
  const defaults = { enabled: true, depthModel: DEFAULT_MODELS.depth, segmentModel: DEFAULT_MODELS.segment, clipModel: DEFAULT_MODELS.clip };
  let prefs = defaults;
  try {
    const raw = localStorage.getItem('trueform.ai');
    if (raw) prefs = { ...defaults, ...JSON.parse(raw) };
  } catch {
    // storage unavailable
  }
  // ?ai=0 forces the classical pipeline (offline use, automated tests).
  if (new URLSearchParams(location.search).get('ai') === '0') prefs.enabled = false;
  return prefs;
}

const ml = new MLClient();
let viewer: Viewer | null = null;

// ---------------------------------------------------------------------------
// DOM helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

let toastTimer = 0;
function toast(msg: string, kind: 'info' | 'error' = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind === 'error' ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = 'toast'), kind === 'error' ? 6000 : 3500);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------------------------------------------------------------------------
// Progress overlay

const progress = {
  show(title: string) {
    $('progress').hidden = false;
    $('progress-title').textContent = title;
    $('progress-log').innerHTML = '';
    this.set(0);
  },
  set(f: number) {
    $('progress-fill').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
  },
  step(text: string): HTMLLIElement {
    const log = $('progress-log');
    log.querySelectorAll('li.active').forEach((li) => li.classList.replace('active', 'done'));
    const li = el('li', { class: 'active', text });
    log.append(li);
    li.scrollIntoView({ block: 'nearest' });
    return li;
  },
  warn(text: string) {
    $('progress-log').append(el('li', { class: 'warn', text }));
  },
  hide() {
    $('progress-log').querySelectorAll('li.active').forEach((li) => li.classList.replace('active', 'done'));
    setTimeout(() => ($('progress').hidden = true), 600);
  },
};

function modelProgress(li: HTMLLIElement, base: string) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (p: MLProgress) => {
    if (p.status === 'progress' && p.file && p.total) {
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      li.textContent = `${base} — downloading model ${Math.round((loaded / total) * 100)}% (${(loaded / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB, cached afterwards)`;
    } else if (p.status === 'ready' || p.status === 'done') {
      li.textContent = base;
    }
  };
}

function setAiBadge(text: string, kind: 'on' | 'warn' | '' = '') {
  const b = $('ai-badge');
  b.textContent = text;
  b.className = `badge ${kind}`;
}

// ---------------------------------------------------------------------------
// Cut-out and depth (cached per photo)

const cutoutMode = () => ($('cutout-mode') as HTMLSelectElement).value as CutoutMode;
const tolerance = () => Number(($('tolerance') as HTMLInputElement).value);

function aiUsable(model: string) {
  return state.ai.enabled && !state.aiFailed.has(model);
}

async function ensureMask(p: Photo, li?: HTMLLIElement, isReference = false): Promise<void> {
  let mode = cutoutMode();
  // Web references are usually JPEGs on busy backgrounds: never use their (absent) alpha or keep them whole.
  if (isReference && (mode === 'alpha' || mode === 'none')) mode = 'auto';
  const useAi = aiUsable(state.ai.segmentModel);
  const key = `${mode}|${tolerance()}|${useAi ? state.ai.segmentModel : 'no-ai'}`;
  if (p.mask && p.maskKey === key) return;
  let mask: ByteField | null = null;
  let method = '';
  if (mode === 'none') {
    mask = createByte(p.image.width, p.image.height);
    mask.data.fill(255);
    method = 'whole image';
  } else if (mode === 'alpha' || (mode === 'auto' && hasUsefulAlpha(p.image))) {
    mask = alphaMask(p.image);
    method = 'image transparency';
  } else if (mode === 'ai' || (mode === 'auto' && useAi)) {
    if (useAi) {
      try {
        const small = limitSize(p.image, 1024);
        const m = await ml.segment(small, state.ai.segmentModel, li ? modelProgress(li, li.textContent || '') : undefined);
        const full = m.width === p.image.width && m.height === p.image.height ? m : resizeByte(m, p.image.width, p.image.height);
        mask = refineMatte(full);
        method = 'AI matting';
        setAiBadge('AI: ready', 'on');
      } catch (e) {
        state.aiFailed.add(state.ai.segmentModel);
        progress.warn(`AI matting unavailable (${(e as Error).message}); using colour key`);
        setAiBadge('AI: partial', 'warn');
      }
    } else if (mode === 'ai') {
      progress.warn('AI is disabled or failed; using colour key');
    }
  }
  if (!mask) {
    const res = segmentByColor(p.image, { tolerance: tolerance(), enclosedHoles: true, workSize: 512 });
    mask = res.mask;
    method = res.method === 'none' ? 'whole image (no backdrop found)' : `colour key (${Math.round(res.confidence * 100)}% border match)`;
  }
  p.mask = mask;
  p.maskKey = key;
  p.maskMethod = method;
  p.depth = undefined;
  p.depthKey = undefined;
}

/** Depth from the network, run on a crop around the object so it gets as many pixels as possible. */
async function ensureDepth(p: Photo, li?: HTMLLIElement): Promise<void> {
  if (!aiUsable(state.ai.depthModel) || !p.mask) {
    p.depth = undefined;
    return;
  }
  const key = `${p.maskKey}|${state.ai.depthModel}`;
  if (p.depth && p.depthKey === key) return;
  const box = maskBBox(p.mask);
  if (!box) return;
  const rect = padRect(box, Math.round(Math.max(box.width, box.height) * 0.08), p.image.width, p.image.height);
  const crop = limitSize(cropRGBA(p.image, rect), 768);
  try {
    p.depth = await ml.depth(crop, state.ai.depthModel, li ? modelProgress(li, li.textContent || '') : undefined);
    p.depthRect = rect;
    p.depthKey = key;
    setAiBadge('AI: ready', 'on');
  } catch (e) {
    state.aiFailed.add(state.ai.depthModel);
    progress.warn(`Depth model unavailable (${(e as Error).message}); using silhouette shape only`);
    setAiBadge('AI: partial', 'warn');
    p.depth = undefined;
  }
}

// ---------------------------------------------------------------------------
// Photo loading

async function loadDropped(d: DroppedImage, max: number): Promise<{ image: RGBAImage; name: string; source: string; resultId?: string }> {
  if (d.kind === 'file') return { image: await blobToRGBA(d.blob, max), name: d.name, source: 'your file' };
  if (d.kind === 'url') return { image: await urlToRGBA(d.url, max), name: d.name, source: d.url };
  const c = state.candidates[d.index];
  if (!c) throw new Error('That search result is no longer available');
  return loadCandidate(c, max);
}

async function loadCandidate(c: Candidate, max: number) {
  let image: RGBAImage;
  try {
    image = await urlToRGBA(c.result.url, max);
  } catch {
    image = await urlToRGBA(c.result.thumbnail, max);
  }
  return { image, name: c.result.title, source: c.result.pageUrl || c.result.url, resultId: c.result.id };
}

async function setFront(image: RGBAImage, name: string, source: string) {
  state.front = { image, name, source };
  state.frontEmbedding = null;
  state.result = null;
  $('dz-empty').hidden = true;
  $('photo-preview').hidden = false;
  $('photo-tools').hidden = false;
  ($('generate-btn') as HTMLButtonElement).disabled = false;
  const q = $('query') as HTMLInputElement;
  const fromName = queryFromFilename(name);
  if (fromName) q.value = fromName;
  updateBrowserLinks();
  await refreshMaskPreview();
  if (state.ai.enabled && !fromName) void identify(false);
}

async function refreshMaskPreview() {
  const p = state.front;
  if (!p) return;
  const show = ($('show-mask') as HTMLInputElement).checked;
  const canvas = $('photo-preview') as HTMLCanvasElement;
  drawPreview(canvas, p.image, null);
  if (show) {
    $('photo-info').textContent = 'Cutting out the object…';
    await nextFrame();
    await ensureMask(p);
    drawPreview(canvas, p.image, p.mask ?? null);
  }
  $('photo-info').textContent = `${p.name} · ${p.image.width}×${p.image.height}px${p.maskMethod ? ` · cut-out: ${p.maskMethod}` : ''}`;
  $('tolerance-field').hidden = !(cutoutMode() === 'color' || (p.maskMethod ?? '').startsWith('colour'));
}

// ---------------------------------------------------------------------------
// Identify + web search

async function identify(force: boolean) {
  const p = state.front;
  if (!p) return;
  const q = $('query') as HTMLInputElement;
  const fromName = queryFromFilename(p.name);
  if (!aiUsable(state.ai.clipModel)) {
    if (force) toast(fromName ? `Using the file name: “${fromName}”` : 'AI identification is off — type what the object is.');
    if (fromName && !q.value) q.value = fromName;
    return;
  }
  const btn = $('identify-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Identifying…';
  try {
    const emb = await frontEmbedding();
    if (!state.clipLabelVecs) state.clipLabelVecs = await ml.embedTexts(LABELS.map(PROMPT), state.ai.clipModel);
    const top = topLabels(emb, state.clipLabelVecs, LABELS, 5);
    state.label = top[0].label;
    const chips = $('suggestions');
    chips.innerHTML = '';
    for (const t of top) {
      const b = el('button', { class: 'chip', text: `${t.label} ${Math.round(t.score * 100)}%`, title: 'Use as search query' });
      b.onclick = () => {
        q.value = t.label;
        state.label = t.label;
        updateBrowserLinks();
      };
      chips.append(b);
    }
    if (!q.value || force) q.value = fromName && !force ? fromName : top[0].label;
    updateBrowserLinks();
    setAiBadge('AI: ready', 'on');
  } catch (e) {
    state.aiFailed.add(state.ai.clipModel);
    setAiBadge('AI: partial', 'warn');
    if (force) toast(`AI identification failed: ${(e as Error).message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Identify';
  }
}

async function frontEmbedding(): Promise<Float32Array> {
  if (state.frontEmbedding) return state.frontEmbedding;
  const p = state.front!;
  const [v] = await ml.embedImages([limitSize(p.image, 448)], state.ai.clipModel);
  state.frontEmbedding = v;
  return v;
}

function updateBrowserLinks() {
  const q = ($('query') as HTMLInputElement).value.trim() || state.label || 'object';
  const box = $('browser-links');
  box.innerHTML = '';
  for (const l of browserSearchLinks(`${q} back view`)) {
    box.append(el('a', { href: l.href, target: '_blank', rel: 'noopener noreferrer', text: l.label }));
  }
}

async function runSearch(): Promise<boolean> {
  const qInput = $('query') as HTMLInputElement;
  let q = qInput.value.trim();
  if (!q && state.front) {
    await identify(false);
    q = qInput.value.trim();
  }
  if (!q) {
    toast('Type what the object is first (e.g. “red ceramic teapot”).', 'error');
    qInput.focus();
    return false;
  }
  const status = $('search-status');
  status.textContent = `Searching the web for “${q}” from several angles…`;
  ($('search-btn') as HTMLButtonElement).disabled = true;
  try {
    const res = await searchReferences(q, true);
    state.candidates = res.results.slice(0, 60).map((result) => ({ result }));
    state.rankMode = null;
    renderResults();
    const failed = res.errors.length ? ` (${res.errors.map((e) => e.provider).filter((v, i, a) => a.indexOf(v) === i).join(', ')} unavailable)` : '';
    status.textContent = state.candidates.length
      ? `${state.candidates.length} images from ${res.providers.map((p) => p.label).join(', ')}${failed}. Ranking by similarity…`
      : `No images found${failed}. Try a different description, or search in your own browser below.`;
    if (state.candidates.length) await rankCandidates();
    return state.candidates.length > 0;
  } catch (e) {
    status.textContent = `Search failed: ${(e as Error).message}. You can still search in your own browser below and drag images in.`;
    return false;
  } finally {
    ($('search-btn') as HTMLButtonElement).disabled = false;
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function rankCandidates() {
  const p = state.front;
  if (!p) return;
  await mapLimit(state.candidates, 6, async (c) => {
    try {
      c.thumb = await urlToRGBA(c.result.thumbnail, 256);
    } catch {
      c.failed = true;
    }
  });
  const ok = state.candidates.filter((c) => c.thumb);
  if (!ok.length) {
    $('search-status').textContent = 'None of the found images could be downloaded. Try another search or drag images in.';
    renderResults();
    return;
  }
  const hints = ok.map((c) => c.result.hint);
  let scored: Scored[] | null = null;
  if (aiUsable(state.ai.clipModel)) {
    try {
      const input = await frontEmbedding();
      const vecs = await ml.embedImages(ok.map((c) => c.thumb!), state.ai.clipModel);
      const label = ($('query') as HTMLInputElement).value.trim() || state.label || 'object';
      const prompts = viewPrompts(label);
      const tv = await ml.embedTexts(CANDIDATE_VIEWS.map((v) => prompts[v]), state.ai.clipModel);
      const viewVecs = Object.fromEntries(CANDIDATE_VIEWS.map((v, i) => [v, tv[i]])) as Record<CandidateView, Float32Array>;
      scored = scoreWithClip(input, vecs, viewVecs, hints);
      state.rankMode = 'clip';
    } catch (e) {
      state.aiFailed.add(state.ai.clipModel);
      setAiBadge('AI: partial', 'warn');
      console.warn('CLIP ranking failed', e);
    }
  }
  if (!scored) {
    scored = scoreWithColor(p.image, ok.map((c) => c.thumb!), hints);
    state.rankMode = 'color';
  }
  scored.forEach((s, i) => (ok[s.index].score = { ...s, index: i }));
  state.candidates.sort((a, b) => (b.score?.similarity ?? -1) - (a.score?.similarity ?? -1));
  renderResults();
  ($('autopick-btn') as HTMLButtonElement).disabled = false;
  $('search-status').textContent = `${ok.length} images ranked by ${state.rankMode === 'clip' ? 'visual similarity (CLIP)' : 'colour similarity'}. Hover a result to use it as a view.`;
}

const VIEW_LABEL: Record<CandidateView, string> = { front: 'front', back: 'back', side: 'side', top: 'top' };

function renderResults() {
  const box = $('results');
  box.innerHTML = '';
  state.candidates.forEach((c, index) => {
    if (c.failed) return;
    const assigned = VIEW_NAMES.find((v) => state.refs[v]?.resultId === c.result.id);
    const tile = el('div', { class: `result${assigned ? ' assigned' : ''}`, draggable: 'true', title: `${c.result.title}\n${c.result.source}${c.result.license ? ` · ${c.result.license}` : ''}` });
    const img = el('img', { src: proxied(c.result.thumbnail), alt: c.result.title, loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.onerror = () => tile.classList.add('broken');
    tile.append(img);
    if (c.score) {
      tile.append(el('span', { class: 'tag', text: assigned ? `→ ${assigned}` : VIEW_LABEL[c.score.view] }));
      tile.append(el('span', { class: 'sim', text: `${Math.round(c.score.similarity * 100)}%`, title: 'Similarity to your photo' }));
    }
    const menu = el('div', { class: 'result-menu' });
    for (const v of VIEW_NAMES) {
      const b = el('button', { text: `Use as ${v}` });
      b.onclick = (e) => {
        e.stopPropagation();
        void assignCandidate(v, c);
      };
      menu.append(b);
    }
    tile.append(menu);
    tile.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('application/x-trueform-result', String(index));
      e.dataTransfer?.setData('text/uri-list', c.result.url);
    });
    box.append(tile);
  });
}

async function assignCandidate(view: ViewName, c: Candidate) {
  try {
    toast(`Loading ${view} view…`);
    const loaded = await loadCandidate(c, REF_MAX);
    setRef(view, { ...loaded, flip: false });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

async function autoPick(): Promise<ViewName[]> {
  const ranked = state.candidates.filter((c) => c.score);
  if (!ranked.length || !state.rankMode) return [];
  const picks = autoAssign(
    ranked.map((c, i) => ({ ...c.score!, index: i })),
    state.rankMode,
  );
  const done: ViewName[] = [];
  for (const [slot, idx] of Object.entries(picks) as [ViewName, number][]) {
    if (state.refs[slot]) continue;
    try {
      const loaded = await loadCandidate(ranked[idx], REF_MAX);
      setRef(slot, { ...loaded, flip: false });
      done.push(slot);
    } catch {
      // skip images that cannot be fetched
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Reference slots

const SLOT_INFO: Record<ViewName, string> = {
  back: 'Back',
  left: 'Left side',
  right: 'Right side',
  top: 'Top',
};

function setRef(view: ViewName, data: { image: RGBAImage; name: string; source: string; flip: boolean; resultId?: string } | null) {
  state.refs[view] = data ? { ...data } : null;
  renderSlots();
  renderResults();
  scheduleRegenerate();
}

function renderSlots() {
  const box = $('slots');
  box.innerHTML = '';
  for (const v of VIEW_NAMES) {
    const ref = state.refs[v];
    const slot = el('div', { class: `slot${ref ? ' filled' : ''}`, 'data-view': v });
    const title = el('div', { class: 'slot-title' }, el('span', { text: SLOT_INFO[v] }));
    const body = el('div', { class: 'slot-body' });
    if (ref) {
      const c = el('canvas');
      const img = ref.flip ? flipped(ref.image) : ref.image;
      drawPreview(c, img, null, 160);
      body.append(c);
      slot.title = `From: ${ref.source}`;
    } else {
      body.append(el('span', { class: 'placeholder', text: 'Drop image' }));
    }
    const actions = el('div', { class: 'slot-actions' });
    if (ref) {
      const flip = el('button', { text: '⇋', title: 'Mirror (if the object faces the other way)' });
      flip.onclick = () => {
        ref.flip = !ref.flip;
        ref.mask = undefined;
        ref.depth = undefined;
        renderSlots();
        scheduleRegenerate();
      };
      const clear = el('button', { text: '✕', title: 'Remove' });
      clear.onclick = () => setRef(v, null);
      actions.append(flip, clear);
    } else {
      const up = el('button', { text: 'File', title: 'Upload an image' });
      up.onclick = () => pickFile((f) => loadIntoSlot(v, { kind: 'file', blob: f, name: f.name }));
      const url = el('button', { text: 'URL', title: 'Paste an image address' });
      url.onclick = () => {
        const u = prompt(`Image address for the ${SLOT_INFO[v].toLowerCase()} view:`);
        if (u && /^https?:\/\//i.test(u.trim())) void loadIntoSlot(v, { kind: 'url', url: u.trim(), name: 'web-image' });
      };
      actions.append(up, url);
    }
    slot.append(title, body, actions);
    wireDrop(slot, (d) => loadIntoSlot(v, d));
    box.append(slot);
  }
}

function flipped(img: RGBAImage): RGBAImage {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data.length) };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 4;
      const d = (y * img.width + img.width - 1 - x) * 4;
      out.data.set(img.data.subarray(s, s + 4), d);
    }
  }
  return out;
}

async function loadIntoSlot(view: ViewName, d: DroppedImage) {
  try {
    const loaded = await loadDropped(d, REF_MAX);
    setRef(view, { ...loaded, flip: false });
    toast(`${SLOT_INFO[view]} view added`);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function pickFile(cb: (f: File) => void) {
  const input = el('input', { type: 'file', accept: 'image/*' });
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) cb(f);
  };
  input.click();
}

function wireDrop(target: HTMLElement, onDrop: (d: DroppedImage) => void) {
  target.addEventListener('dragover', (e) => {
    e.preventDefault();
    target.classList.add('drag');
  });
  target.addEventListener('dragleave', () => target.classList.remove('drag'));
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    target.classList.remove('drag');
    const d = readDataTransfer(e.dataTransfer);
    if (d) onDrop(d);
    else toast('Could not read that drop — try dragging the image itself, or use the URL button.', 'error');
  });
}

// ---------------------------------------------------------------------------
// Settings panel

type Control =
  | { key: keyof ReconstructSettings; label: string; type: 'range'; min: number; max: number; step: number; fmt?: (v: number) => string; full?: boolean }
  | { key: keyof ReconstructSettings; label: string; type: 'select'; options: [string | number, string][]; full?: boolean }
  | { key: keyof ReconstructSettings; label: string; type: 'check'; full?: boolean };

const CONTROLS: Control[] = [
  { key: 'resolution', label: 'Mesh detail', type: 'select', options: [[128, 'Low · fast'], [192, 'Medium'], [256, 'High'], [384, 'Very high'], [512, 'Ultra']] },
  { key: 'textureSize', label: 'Texture size', type: 'select', options: [[2048, '2K'], [4096, '4K'], [8192, '8K']] },
  { key: 'thickness', label: 'Thickness', type: 'range', min: 0.1, max: 2.5, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
  { key: 'depthStrength', label: 'Depth relief (AI)', type: 'range', min: 0, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
  { key: 'roundness', label: 'Roundness', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'smoothing', label: 'Smoothing', type: 'range', min: 0, max: 4, step: 0.25, fmt: (v) => v.toFixed(2) },
  { key: 'shadingDetail', label: 'Detail from shading', type: 'range', min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
  { key: 'colorMatch', label: 'Match reference colours', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'sideBlend', label: 'Side photos on steep areas', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%`, full: true },
  { key: 'backShape', label: 'Back shape', type: 'select', options: [['auto', 'Auto'], ['reference', 'From back photo'], ['mirror', 'Mirror of front'], ['round', 'Rounded'], ['flat', 'Flat (relief)']] },
  { key: 'backTexture', label: 'Back texture', type: 'select', options: [['auto', 'Auto'], ['reference', 'From back photo'], ['tone', 'Front colours, no detail'], ['mirror', 'Mirror of front']] },
  { key: 'keepTilt', label: 'Keep camera perspective tilt', type: 'check', full: true },
];

function buildSettings() {
  const body = $('settings-body');
  body.innerHTML = '';
  for (const c of CONTROLS) {
    const wrap = el('label', { class: `field${c.full ? ' full' : ''}` });
    const value = state.settings[c.key];
    if (c.type === 'range') {
      const out = el('output', { text: c.fmt ? c.fmt(value as number) : String(value) });
      const input = el('input', { type: 'range', min: String(c.min), max: String(c.max), step: String(c.step), value: String(value) });
      input.oninput = () => {
        (state.settings[c.key] as number) = Number(input.value);
        out.textContent = c.fmt ? c.fmt(Number(input.value)) : input.value;
        settingsChanged();
      };
      wrap.append(el('span', {}, c.label, out), input);
    } else if (c.type === 'select') {
      const sel = el('select');
      for (const [v, l] of c.options) sel.append(el('option', { value: String(v), text: l }));
      sel.value = String(value);
      sel.onchange = () => {
        const num = Number(sel.value);
        (state.settings[c.key] as unknown) = Number.isNaN(num) ? sel.value : num;
        settingsChanged();
      };
      wrap.append(c.label, sel);
    } else {
      wrap.className = `toggle${c.full ? ' full' : ''}`;
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!value;
      cb.onchange = () => {
        (state.settings[c.key] as boolean) = cb.checked;
        settingsChanged();
      };
      wrap.append(cb, c.label);
    }
    body.append(wrap);
  }

  // AI options.
  const ai = el('div', { class: 'full' });
  const aiToggle = el('label', { class: 'toggle' });
  const cb = el('input', { type: 'checkbox' });
  cb.checked = state.ai.enabled;
  cb.onchange = () => {
    state.ai.enabled = cb.checked;
    state.aiFailed.clear();
    saveSettings();
    setAiBadge(state.ai.enabled ? 'AI: on' : 'AI: off', state.ai.enabled ? 'on' : '');
    if (state.front) {
      state.front.maskKey = undefined;
      void refreshMaskPreview();
    }
  };
  aiToggle.append(cb, 'Use AI models in the browser (depth, matting, CLIP · ~250 MB, downloaded once and cached)');
  ai.append(aiToggle);
  const models: [keyof typeof state.ai, string][] = [
    ['depthModel', 'Depth model'],
    ['segmentModel', 'Matting model'],
    ['clipModel', 'Similarity model'],
  ];
  const grid = el('div', { class: 'settings' });
  for (const [k, label] of models) {
    const input = el('input', { type: 'text', value: String(state.ai[k]), spellcheck: 'false' });
    input.onchange = () => {
      (state.ai[k] as string) = input.value.trim() || (DEFAULT_MODELS as Record<string, string>)[k.replace('Model', '')];
      state.aiFailed.clear();
      if (k === 'clipModel') state.clipLabelVecs = null;
      saveSettings();
    };
    grid.append(el('label', { class: 'field' }, label, input));
  }
  const reset = el('button', { class: 'ghost small', text: 'Reset to defaults' });
  reset.onclick = () => {
    state.settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    buildSettings();
    settingsChanged();
  };
  ai.append(grid, reset);
  body.append(ai);
}

let regenTimer = 0;
function settingsChanged() {
  saveSettings();
  scheduleRegenerate();
}

function scheduleRegenerate() {
  if (!state.result) return;
  clearTimeout(regenTimer);
  regenTimer = window.setTimeout(() => {
    if (state.busy) state.dirty = true;
    else void generate({ quick: true });
  }, 400);
}

// ---------------------------------------------------------------------------
// Generation

let reconWorker: Worker | null = null;
let reconSeq = 0;

function runReconstruct(input: ReconstructInput, onProgress: (stage: string, f: number) => void): Promise<MeshResult> {
  reconWorker ??= new Worker(new URL('./core/reconstruct.worker.ts', import.meta.url), { type: 'module' });
  const id = ++reconSeq;
  const w = reconWorker;
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<ReconstructWorkerOut>) => {
      if (e.data.id !== id) return;
      if (e.data.kind === 'progress') onProgress(e.data.stage, e.data.fraction);
      else {
        w.removeEventListener('message', onMsg);
        if (e.data.kind === 'result') resolve(e.data.result);
        else reject(new Error(e.data.error));
      }
    };
    w.addEventListener('message', onMsg);
    w.onerror = (e) => reject(new Error(e.message || 'Reconstruction worker failed'));
    w.postMessage({ id, input } satisfies ReconstructWorkerIn);
  });
}

function toView(p: Photo & { flip?: boolean }): ViewInput {
  return { image: p.image, mask: p.mask!, depth: p.depth, depthRect: p.depthRect, flip: p.flip };
}

async function generate(opts: { quick?: boolean } = {}) {
  const front = state.front;
  if (!front || state.busy) return;
  state.busy = true;
  state.dirty = false;
  const gen = ++state.generation;
  const btn = $('generate-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  if (!opts.quick) progress.show('Building your 3D model');
  const step = (t: string) => (opts.quick ? null : progress.step(t));
  try {
    let li = step('Cutting out the object');
    await ensureMask(front, li ?? undefined);
    progress.set(0.12);
    if (aiUsable(state.ai.depthModel)) {
      li = step('Estimating depth with Depth Anything (in your browser)');
      await ensureDepth(front, li ?? undefined);
    }
    progress.set(0.35);

    const hasRefs = VIEW_NAMES.some((v) => state.refs[v]);
    if (!opts.quick && !hasRefs && ($('auto-refs') as HTMLInputElement).checked) {
      step('Looking up reference views of this object on the web');
      if (!state.candidates.length || !state.rankMode) await runSearch();
      const picked = await autoPick();
      if (picked.length) step(`Using web photos for: ${picked.join(', ')}`);
      else progress.warn('No confident matches for the back/sides on the web — using shape priors instead. You can pick or drop views manually.');
    }
    progress.set(0.5);

    const refs: Partial<Record<ViewName, ViewInput>> = {};
    for (const v of VIEW_NAMES) {
      const r = state.refs[v];
      if (!r) continue;
      li = step(`Preparing ${SLOT_INFO[v].toLowerCase()} view`);
      await ensureMask(r, li ?? undefined, true);
      if (v === 'back') await ensureDepth(r, li ?? undefined);
      refs[v] = toView(r);
    }
    progress.set(0.6);

    const reconLi = step('Reconstructing mesh and baking texture');
    const result = await runReconstruct({ front: toView(front), refs, settings: { ...state.settings } }, (stage, f) => {
      progress.set(0.6 + f * 0.4);
      if (reconLi) reconLi.textContent = `Reconstructing — ${stage.toLowerCase()}`;
    });
    if (gen !== state.generation) return;
    showResult(result);
    progress.set(1);
    if (!opts.quick) {
      step(`Done — ${result.stats.triangles.toLocaleString()} triangles${result.stats.watertight ? ', watertight' : ''}`);
      progress.hide();
    }
  } catch (e) {
    progress.warn((e as Error).message);
    toast((e as Error).message, 'error');
    if (!opts.quick) setTimeout(() => ($('progress').hidden = true), 4000);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = 'Generate 3D model';
    if (state.dirty) scheduleRegenerate();
  }
}

function showResult(result: MeshResult) {
  state.result = result;
  state.atlasCanvas = rgbaToCanvas(result.atlas);
  viewer ??= new Viewer($('viewer'));
  viewer.setModel(result, state.atlasCanvas);
  viewer.setShading(currentShading);
  viewer.setWireframe($('wire-btn').getAttribute('aria-pressed') === 'true');
  $('empty-state').hidden = true;
  $('toolbar').hidden = false;
  $('exports').hidden = false;
  const s = result.stats;
  const views = s.usedRefs.length ? s.usedRefs.join(', ') : 'none';
  $('stats').hidden = false;
  $('stats').innerHTML = `<b>${s.triangles.toLocaleString()}</b> triangles · depth: <b>${s.usedDepth ? 'AI' : 'silhouette'}</b> · web views: <b>${views}</b> · back: <b>${s.backShape}/${s.backTexture}</b> · ${
    s.watertight ? '<span class="ok">watertight ✓</span>' : 'open mesh'
  }`;
}

// ---------------------------------------------------------------------------
// Viewer toolbar + export

let currentShading: Shading = 'lit';

function wireToolbar() {
  document.querySelectorAll<HTMLButtonElement>('[data-shading]').forEach((b) => {
    b.onclick = () => {
      currentShading = b.dataset.shading as Shading;
      document.querySelectorAll('[data-shading]').forEach((x) => x.classList.toggle('active', x === b));
      viewer?.setShading(currentShading);
    };
  });
  const toggle = (id: string, fn: (on: boolean) => void) => {
    const b = $(id);
    b.onclick = () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      fn(on);
    };
  };
  toggle('wire-btn', (on) => viewer?.setWireframe(on));
  toggle('rotate-btn', (on) => viewer?.setAutoRotate(on));
  toggle('compare-btn', (on) => {
    viewer?.setCompare(on);
    $('compare-bar').hidden = !on;
    if (on) {
      // The exact comparison is against the unlit render (the photo already contains the lighting).
      document.querySelector<HTMLButtonElement>('[data-shading="unlit"]')?.click();
      viewer?.setSplit(Number(($('split') as HTMLInputElement).value));
    }
  });
  $('split').oninput = () => viewer?.setSplit(Number(($('split') as HTMLInputElement).value));
  $('reset-btn').onclick = () => viewer?.resetView();

  document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((b) => {
    b.onclick = async () => {
      const r = state.result;
      if (!r || !state.atlasCanvas) return;
      const kind = b.dataset.export!;
      let modelHeight = 0;
      for (let i = 1; i < r.positions.length; i += 3) modelHeight = Math.max(modelHeight, r.positions[i]);
      const cm = Math.max(0.1, Number(($('real-height') as HTMLInputElement).value) || 20);
      const metres = cm / 100 / (modelHeight || 1);
      const base = (state.front?.name || 'model').replace(/\.[a-z0-9]+$/i, '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'model';
      const mesh = { positions: r.positions, normals: r.normals, uvs: r.uvs, indices: r.indices };
      b.disabled = true;
      try {
        if (kind === 'glb') download(await exportGLB(mesh, state.atlasCanvas, metres, currentShading === 'unlit'), `${base}.glb`);
        else if (kind === 'obj') download(await exportOBJZip(mesh, state.atlasCanvas, metres), `${base}_obj.zip`);
        else if (kind === 'stl') download(exportSTL(mesh, metres * 1000), `${base}.stl`);
        else if (kind === 'usdz') download(await exportUSDZ(mesh, state.atlasCanvas, metres), `${base}.usdz`);
        toast(`Exported ${kind.toUpperCase()}`);
      } catch (e) {
        toast(`Export failed: ${(e as Error).message}`, 'error');
      } finally {
        b.disabled = false;
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Boot

function wireInputs() {
  const dz = $('dropzone');
  const fileInput = $('file-input') as HTMLInputElement;
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (f) await loadFront({ kind: 'file', blob: f, name: f.name });
    fileInput.value = '';
  };
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  wireDrop(dz, (d) => void loadFront(d));
  // Dropping anywhere on the page outside a slot loads the main photo.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const d = readDataTransfer(e.dataTransfer);
    if (d) void loadFront(d);
  });
  document.addEventListener('paste', (e) => {
    if ((e.target as HTMLElement)?.closest('input, textarea')) return;
    const d = readDataTransfer(e.clipboardData);
    if (!d) return;
    if (!state.front) void loadFront(d);
    else {
      const empty = VIEW_NAMES.find((v) => !state.refs[v]);
      if (empty) void loadIntoSlot(empty, d);
      else void loadFront(d);
    }
  });

  ($('cutout-mode') as HTMLSelectElement).onchange = () => {
    void refreshMaskPreview().then(scheduleRegenerate);
  };
  let tolTimer = 0;
  $('tolerance').oninput = () => {
    clearTimeout(tolTimer);
    tolTimer = window.setTimeout(() => void refreshMaskPreview().then(scheduleRegenerate), 250);
  };
  ($('show-mask') as HTMLInputElement).onchange = () => void refreshMaskPreview();
  $('identify-btn').onclick = () => void identify(true);
  $('search-btn').onclick = () => void runSearch();
  ($('query') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSearch();
  });
  ($('query') as HTMLInputElement).addEventListener('input', updateBrowserLinks);
  $('autopick-btn').onclick = async () => {
    const picked = await autoPick();
    toast(picked.length ? `Picked: ${picked.join(', ')}` : 'No result looks like the same object from another side. Pick one manually.');
  };
  $('generate-btn').onclick = () => void generate();
}

async function loadFront(d: DroppedImage) {
  try {
    const loaded = await loadDropped(d, FRONT_MAX);
    await setFront(loaded.image, loaded.name, loaded.source);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

async function boot() {
  buildSettings();
  renderSlots();
  wireInputs();
  wireToolbar();
  updateBrowserLinks();
  setAiBadge(state.ai.enabled ? 'AI: on' : 'AI: off', state.ai.enabled ? 'on' : '');
  const health = await apiHealth();
  const sb = $('search-badge');
  if (health?.providers?.length) {
    sb.textContent = `Web search: ${health.providers.length} source${health.providers.length > 1 ? 's' : ''}`;
    sb.title = health.providers.map((p) => p.label).join(', ');
    sb.className = 'badge on';
  } else {
    sb.textContent = 'Web search: offline';
    sb.className = 'badge warn';
    sb.title = 'The search API is not reachable. Use “Search in your own browser” and drag images in.';
  }
  // Expose a tiny hook for automated tests.
  (window as unknown as { __trueform: unknown }).__trueform = { state, generate, setFront };
}

void boot();
