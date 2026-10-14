import './styles.css';
import { createByte, cropRGBA, limitSize, maskBBox, padRect, resizeByte } from './core/imageops';
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
import { apiHealth, browserSearchLinks, searchReferences, type SearchResult } from './search/client';
import { LABELS, PROMPT, queryFromFilename, topLabels } from './search/identify';
import {
  autoAssign,
  CANDIDATE_VIEWS,
  edgeProfiles,
  frontEndColors,
  isMirrorSymmetric,
  objectColors,
  scoreWithClip,
  scoreWithColor,
  sideFacing,
  viewPrompts,
  whichEnd,
  type CandidateView,
  type EdgeProfiles,
  type Scored,
  type SideEnd,
} from './search/rank';
import { loadSamples, sampleResults, type Sample } from './search/samples';
import { blobToRGBA, drawPreview, fetchImage, nameFromUrl, readDataTransfer, rgbaToCanvas, urlToRGBA, type DroppedImage } from './ui/imageio';
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
  /** Sets the depth only, no texture: a side view of which it is unknown which end of the object it shows. */
  shapeOnly: boolean;
  /** One of a bundled sample's reference images. */
  sample: boolean;
  /** Why auto-pick put it here, for the slot's tooltip. */
  note?: string;
}

interface Candidate {
  result: SearchResult;
  /** The thumbnail file, downloaded once: decoded for ranking and shown in its result tile. */
  blob?: Blob;
  /** Object URL of `blob` while the candidate is listed. */
  blobUrl?: string;
  /** The result tile's image, kept across re-renders so it is not requested again. */
  img?: HTMLImageElement;
  thumb?: RGBAImage;
  score?: Scored;
  failed?: boolean;
  /** The object cut out of `thumb` where its backdrop is plain (null: it could not be). */
  cut?: ByteField | null;
  /** Object colours, for telling which end of the object a side view shows. */
  colors?: Float32Array;
}

const FRONT_MAX = 2048;
const REF_MAX = 1024;

/** The static demo build (npm run build:demo): no search server, sample images bundled. */
const DEMO = import.meta.env.MODE === 'demo';
const DEMO_SEARCH_NOTE = 'Live web search needs the TrueForm server (npm start). This hosted demo bundles sample reference images (3D renders) instead.';
const DEMO_AI_NOTE = 'Not available in the hosted demo — run TrueForm locally';
const SHAPE_ONLY_NOTE =
  'Shape only: it is not clear which end of the object this side view shows, so it sets the depth but paints no texture (a wrong guess would put, say, a beak on a tail). Click to use its texture as well.';
const SYMMETRIC_NOTE =
  'The object’s outline is mirror-symmetric and its two ends look alike, so a side view fits either side. It is turned so that its edge showing the front matches the photo.';
const MIRRORED_COPY_NOTE = 'The object’s outline is mirror-symmetric and its two ends look alike, so the other side view, mirrored, serves this side too.';

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
  samples: [] as Sample[],
  /** Set while the photo and candidates are a bundled sample's. */
  sampleId: null as string | null,
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
    // AI off is only the demo's default, so it must not overwrite the choice saved by the full app.
    const ai = DEMO ? { ...state.ai, enabled: JSON.parse(localStorage.getItem('trueform.ai') || '{}').enabled } : state.ai;
    localStorage.setItem('trueform.ai', JSON.stringify(ai));
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
  // The hosted demo cannot download models.
  if (DEMO) prefs.enabled = false;
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
  // Bundled samples have no separate thumbnail: the file ranking downloaded is the full image.
  if (c.blob && c.result.url === c.result.thumbnail) image = await blobToRGBA(c.blob, max);
  else {
    try {
      image = await urlToRGBA(c.result.url, max);
    } catch {
      image = c.blob ? await blobToRGBA(c.blob, max) : await urlToRGBA(c.result.thumbnail, max);
    }
  }
  return { image, name: c.result.title, source: c.result.pageUrl || c.result.url, resultId: c.result.id };
}

async function setFront(image: RGBAImage, name: string, source: string) {
  state.front = { image, name, source };
  state.frontEmbedding = null;
  state.result = null;
  updateModelState();
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
  if (DEMO) {
    $('search-status').textContent = DEMO_SEARCH_NOTE;
    return false;
  }
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
    setCandidates(res.results.slice(0, 60));
    if (state.sampleId) {
      // The candidates are web results now, not the sample's.
      state.sampleId = null;
      renderSamples();
    }
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

/** Replaces the candidates (search results or a sample's images), releasing the previous ones' thumbnails. */
function setCandidates(results: SearchResult[]) {
  for (const c of state.candidates) if (c.blobUrl) URL.revokeObjectURL(c.blobUrl);
  state.candidates = results.map((result) => ({ result }));
  state.rankMode = null;
}

/** Ranks the candidates against the photo; returns how many could be loaded and ranked. */
async function rankCandidates(): Promise<number> {
  const p = state.front;
  if (!p) return 0;
  const list = state.candidates;
  await mapLimit(list, 6, async (c) => {
    try {
      // One download per thumbnail: hosts without cache headers would otherwise serve it again for every re-rendered tile.
      c.blob ??= await fetchImage(c.result.thumbnail);
      c.thumb ??= await blobToRGBA(c.blob, 256);
      if (!c.blobUrl && state.candidates === list) {
        c.blobUrl = URL.createObjectURL(c.blob);
        if (c.img) c.img.src = c.blobUrl;
      }
    } catch {
      c.failed = true;
    }
  });
  const ok = state.candidates.filter((c) => c.thumb);
  if (!ok.length) {
    $('search-status').textContent = 'None of the found images could be downloaded. Try another search or drag images in.';
    renderResults();
    return 0;
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
  $('search-status').textContent = `${ok.length} images ranked by ${rankedBy()}. Hover a result to use it as a view.`;
  return ok.length;
}

const rankedBy = () => (state.rankMode === 'clip' ? 'visual similarity (CLIP)' : 'colour similarity');

const VIEW_LABEL: Record<CandidateView, string> = { front: 'front', back: 'back', side: 'side', top: 'top' };

function renderResults() {
  const box = $('results');
  box.innerHTML = '';
  state.candidates.forEach((c, index) => {
    if (c.failed) return;
    const assigned = VIEW_NAMES.find((v) => state.refs[v]?.resultId === c.result.id);
    const tile = el('div', { class: `result${assigned ? ' assigned' : ''}`, draggable: 'true', title: `${c.result.title}\n${c.result.source}${c.result.license ? ` · ${c.result.license}` : ''}` });
    // The same element every time, showing the thumbnail ranking downloaded (until then, an empty tile).
    c.img ??= el('img', { alt: '', referrerpolicy: 'no-referrer', ...(c.blobUrl ? { src: c.blobUrl } : {}) });
    const img = c.img;
    img.onerror = () => tile.classList.add('broken');
    img.onload = () => (img.alt = c.result.title);
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

/** The object in a reference image, where its backdrop is plain enough for the colour key; else null. */
function cutOut(image: RGBAImage): ByteField | null {
  const seg = segmentByColor(image, { tolerance: tolerance(), enclosedHoles: true, workSize: 256 });
  return seg.method === 'color-key' && seg.confidence >= 0.5 ? seg.mask : null;
}

function candidateCut(c: Candidate): ByteField | null {
  if (!c.thumb) return null;
  if (c.cut === undefined) c.cut = cutOut(c.thumb);
  return c.cut;
}

/** Colours of a candidate's object, cut out of its thumbnail where the backdrop is plain (else its central region). */
function candidateColors(c: Candidate): Float32Array | null {
  if (!c.thumb) return null;
  c.colors ??= objectColors(c.thumb, candidateCut(c));
  return c.colors;
}

function candidateEdges(c: Candidate | undefined): EdgeProfiles | null {
  const cut = c && candidateCut(c);
  return c?.thumb && cut ? edgeProfiles(c.thumb, cut) : null;
}

async function autoPick(): Promise<ViewName[]> {
  const ranked = state.candidates.filter((c) => c.score);
  if (!ranked.length || !state.rankMode) return [];
  // Side views are placed by matching their colours to the two ends of the photo's cut-out.
  const front = state.front;
  if (front) await ensureMask(front);
  const ends = front?.mask ? frontEndColors(front.image, front.mask) : null;
  const sideOf = (i: number): SideEnd | null => {
    const colors = ends && candidateColors(ranked[i]);
    return ends && colors ? whichEnd(colors, ends).end : null;
  };
  // An object that looks the same from either side takes any side view, turned to match the photo and the back view.
  const symmetric = !!(front?.mask && ends && isMirrorSymmetric(front.mask, ends));
  const frontEdges = symmetric && front?.mask ? edgeProfiles(front.image, front.mask) : null;
  const backRef = state.refs.back;
  const frontOn = (i: number, back: number | undefined): SideEnd | null => {
    const side = candidateEdges(ranked[i]);
    if (!frontEdges || !side) return null;
    const backCut = backRef ? (backRef.mask ?? cutOut(backRef.image)) : null;
    const backEdges = backRef ? (backCut ? edgeProfiles(backRef.image, backCut) : null) : candidateEdges(back === undefined ? undefined : ranked[back]);
    return sideFacing(side, frontEdges, backEdges).front;
  };
  const picks = autoAssign(
    ranked.map((c, i) => ({ ...c.score!, index: i })),
    state.rankMode,
    sideOf,
    { symmetric, frontOn },
  );
  const done: ViewName[] = [];
  const loads = new Map<number, ReturnType<typeof loadCandidate>>();
  for (const slot of VIEW_NAMES) {
    const idx = picks.slots[slot];
    if (idx === undefined || state.refs[slot]) continue;
    try {
      // A symmetric object's only side view serves both sides: load it once.
      if (!loads.has(idx)) loads.set(idx, loadCandidate(ranked[idx], REF_MAX));
      const loaded = await loads.get(idx)!;
      const flip = picks.flip.includes(slot);
      const side = slot === 'left' || slot === 'right';
      const copy = side && picks.slots[slot === 'left' ? 'right' : 'left'] === idx && flip;
      const note = symmetric && side && !picks.shapeOnly.includes(slot) ? (copy ? MIRRORED_COPY_NOTE : SYMMETRIC_NOTE) : undefined;
      setRef(slot, { ...loaded, flip, shapeOnly: picks.shapeOnly.includes(slot), note });
      done.push(slot);
    } catch {
      // skip images that cannot be fetched
    }
  }
  return done;
}

/** "back, left (mirrored), right (shape only)" */
const describeViews = (views: ViewName[]) =>
  views.map((v) => (state.refs[v]?.shapeOnly ? `${v} (shape only)` : state.refs[v]?.flip ? `${v} (mirrored)` : v)).join(', ');

// ---------------------------------------------------------------------------
// Bundled samples

/** Resolves once a sample's candidates are ranked; generating waits for it so it does not search the web instead. */
let sampleRanking: Promise<unknown> | null = null;
let healthCheck: ReturnType<typeof apiHealth> = Promise.resolve(null);

function renderSamples() {
  const box = $('sample-buttons');
  box.innerHTML = '';
  for (const sample of state.samples) {
    const b = el('button', { class: `chip${state.sampleId === sample.id ? ' active' : ''}`, text: sample.title, 'data-sample': sample.id, title: `Load the sample photo and its reference views: ${sample.query}` });
    b.onclick = () => void openSample(sample);
    box.append(b);
  }
  $('samples').hidden = state.samples.length === 0;
}

/** Loads a sample's photo and ranks its reference images; false if it could not. */
async function loadSample(sample: Sample): Promise<boolean> {
  if (state.busy) {
    toast('Wait for the current model to finish.');
    return false;
  }
  try {
    const res = await fetch(sample.photo);
    if (!res.ok) throw new Error(`Could not load the sample photo (${res.status})`);
    const image = await blobToRGBA(await res.blob(), FRONT_MAX);
    // Views picked for a previous photo belong to another object.
    for (const v of VIEW_NAMES) state.refs[v] = null;
    renderSlots();
    state.sampleId = sample.id;
    renderSamples();
    await setFront(image, `${sample.id}.jpg`, 'sample photo');
    ($('query') as HTMLInputElement).value = sample.query;
    updateBrowserLinks();
    setCandidates(sampleResults(sample));
    renderResults();
    const status = $('search-status');
    status.textContent = `${state.candidates.length} sample reference images (studio renders of a test object, bundled with the demo). Ranking by similarity…`;
    const ranking = rankCandidates();
    sampleRanking = ranking;
    const ranked = await ranking.finally(() => {
      if (sampleRanking === ranking) sampleRanking = null;
    });
    if (ranked) {
      const live = !!(await healthCheck)?.providers?.length;
      const next = live ? 'Hover a result to use it as a view, or search the web for more.' : DEMO ? 'Live web search needs the TrueForm server (npm start).' : 'Hover a result to use it as a view.';
      status.textContent = `${ranked} sample reference images (studio renders of a test object, bundled with the demo), ranked by ${rankedBy()}. ${next}`;
    }
    return true;
  } catch (e) {
    toast(`Could not load the sample: ${(e as Error).message}`, 'error');
    return false;
  }
}

/** Set while a picked sample is loading in the hosted demo, which builds it next. */
let buildQueued = false;

/** A sample picked by the visitor; the hosted demo builds it straight away, as it does the first one. */
async function openSample(sample: Sample) {
  buildQueued = DEMO && !state.busy;
  try {
    if ((await loadSample(sample)) && DEMO && state.sampleId === sample.id) await generate();
  } finally {
    buildQueued = false;
    updateModelState();
  }
}

/** A photo of the user's own replaces the sample, so the sample's references no longer apply. */
function leaveSample() {
  if (!state.sampleId) return;
  state.sampleId = null;
  setCandidates([]);
  for (const v of VIEW_NAMES) state.refs[v] = null;
  ($('query') as HTMLInputElement).value = '';
  $('search-status').textContent = '';
  ($('autopick-btn') as HTMLButtonElement).disabled = true;
  renderResults();
  renderSlots();
  renderSamples();
}

// ---------------------------------------------------------------------------
// Reference slots

const SLOT_INFO: Record<ViewName, string> = {
  back: 'Back',
  left: 'Left side',
  right: 'Right side',
  top: 'Top',
};

function setRef(view: ViewName, data: { image: RGBAImage; name: string; source: string; flip: boolean; resultId?: string; shapeOnly?: boolean; note?: string } | null) {
  // While a sample is open the candidates are its bundled images.
  state.refs[view] = data ? { ...data, shapeOnly: !!data.shapeOnly, sample: !!state.sampleId && !!data.resultId } : null;
  if (urlSlot?.view === view) urlSlot = null;
  renderSlots();
  renderResults();
  scheduleRegenerate();
}

/** The slot showing an address field instead of its buttons (window.prompt is blocked in embedded hosts). */
let urlSlot: { view: ViewName; draft: string } | null = null;

function renderSlots() {
  const box = $('slots');
  box.innerHTML = '';
  let focus: HTMLInputElement | null = null;
  for (const v of VIEW_NAMES) {
    const ref = state.refs[v];
    const slot = el('div', { class: `slot${ref ? ' filled' : ''}${ref?.shapeOnly ? ' shape-only' : ''}${ref?.flip ? ' mirrored' : ''}`, 'data-view': v });
    const title = el('div', { class: 'slot-title' }, el('span', { text: SLOT_INFO[v] }));
    const body = el('div', { class: 'slot-body' });
    if (ref) {
      const c = el('canvas');
      const img = ref.flip ? flipped(ref.image) : ref.image;
      drawPreview(c, img, null, 160);
      body.append(c);
      slot.title = `From: ${ref.source}${ref.note ? `\n${ref.note}` : ''}`;
      if (ref.shapeOnly) {
        const badge = el('button', { class: 'slot-badge', text: 'shape only', title: SHAPE_ONLY_NOTE });
        badge.onclick = () => {
          ref.shapeOnly = false;
          renderSlots();
          scheduleRegenerate();
        };
        body.append(badge);
      }
    } else if (urlSlot?.view === v) {
      focus = slotUrlInput(v);
      body.append(focus);
    } else {
      body.append(el('span', { class: 'placeholder', text: 'Drop image' }));
    }
    const actions = el('div', { class: 'slot-actions' });
    if (ref) {
      const flip = el('button', { text: '⇋', title: 'Mirror (if the object faces the other way)' });
      flip.onclick = () => {
        ref.flip = !ref.flip;
        // The orientation is the user's now, not auto-pick's.
        ref.note = undefined;
        ref.mask = undefined;
        ref.depth = undefined;
        renderSlots();
        scheduleRegenerate();
      };
      const clear = el('button', { text: '✕', title: 'Remove' });
      clear.onclick = () => setRef(v, null);
      actions.append(flip, clear);
    } else if (urlSlot?.view === v) {
      const add = el('button', { text: 'Add', title: 'Load this address' });
      add.onclick = () => submitSlotUrl(v);
      const cancel = el('button', { text: '✕', title: 'Cancel' });
      cancel.onclick = () => closeSlotUrl();
      actions.append(add, cancel);
    } else {
      const up = el('button', { text: 'File', title: 'Upload an image' });
      up.onclick = () => pickFile((f) => loadIntoSlot(v, { kind: 'file', blob: f, name: f.name }));
      const url = el('button', { text: 'URL', title: 'Paste an image address' });
      url.onclick = () => {
        urlSlot = { view: v, draft: '' };
        renderSlots();
      };
      actions.append(up, url);
    }
    slot.append(title, body, actions);
    wireDrop(slot, (d) => loadIntoSlot(v, d));
    box.append(slot);
  }
  focus?.focus();
}

function slotUrlInput(v: ViewName): HTMLInputElement {
  const input = el('input', {
    type: 'url',
    class: 'slot-url',
    placeholder: 'https://…',
    spellcheck: 'false',
    'aria-label': `Image address for the ${SLOT_INFO[v].toLowerCase()} view`,
  });
  input.value = urlSlot?.draft ?? '';
  input.oninput = () => {
    if (urlSlot) urlSlot.draft = input.value;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSlotUrl(v);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSlotUrl();
    }
  });
  return input;
}

function submitSlotUrl(v: ViewName) {
  const u = (urlSlot?.draft ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(u)) {
    toast('Paste an image address starting with https://', 'error');
    return;
  }
  closeSlotUrl();
  void loadIntoSlot(v, { kind: 'url', url: u, name: nameFromUrl(u) });
}

function closeSlotUrl() {
  urlSlot = null;
  renderSlots();
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
  // The models come from the Hugging Face Hub, which the hosted demo cannot reach.
  if (DEMO) {
    cb.disabled = true;
    aiToggle.classList.add('disabled');
    aiToggle.title = DEMO_AI_NOTE;
    ai.append(el('p', { class: 'hint', id: 'ai-note', text: `${DEMO_AI_NOTE}.` }));
  }
  const models: [keyof typeof state.ai, string][] = [
    ['depthModel', 'Depth model'],
    ['segmentModel', 'Matting model'],
    ['clipModel', 'Similarity model'],
  ];
  const grid = el('div', { class: 'settings' });
  for (const [k, label] of DEMO ? [] : models) {
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
/** Set once the worker has answered; until then an error means it never started. */
let reconWorkerAlive = false;
let reconOnMainThread = false;

function runReconstruct(input: ReconstructInput, onProgress: (stage: string, f: number) => void): Promise<MeshResult> {
  if (!reconOnMainThread && !reconWorker) {
    try {
      reconWorker = new Worker(new URL('./core/reconstruct.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      console.warn('Reconstruction worker unavailable, running on the main thread', e);
      reconOnMainThread = true;
    }
  }
  const w = reconWorker;
  if (reconOnMainThread || !w) return reconstructHere(input, onProgress);
  const id = ++reconSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<ReconstructWorkerOut>) => {
      reconWorkerAlive = true;
      if (e.data.id !== id) return;
      if (e.data.kind === 'progress') onProgress(e.data.stage, e.data.fraction);
      else {
        w.removeEventListener('message', onMsg);
        if (e.data.kind === 'result') resolve(e.data.result);
        else reject(new Error(e.data.error));
      }
    };
    w.addEventListener('message', onMsg);
    w.onerror = (e) => {
      w.removeEventListener('message', onMsg);
      if (reconWorkerAlive) {
        reject(new Error(e.message || 'Reconstruction worker failed'));
        return;
      }
      // The worker script could not start (blocked or failed to load): do the work here instead.
      e.preventDefault();
      console.warn(`Reconstruction worker failed to start, running on the main thread${e.message ? ` (${e.message})` : ''}`);
      w.terminate();
      reconWorker = null;
      reconOnMainThread = true;
      reconstructHere(input, onProgress).then(resolve, reject);
    };
    w.postMessage({ id, input } satisfies ReconstructWorkerIn);
  });
}

async function reconstructHere(input: ReconstructInput, onProgress: (stage: string, f: number) => void): Promise<MeshResult> {
  const { reconstruct } = await import('./core/reconstruct');
  // Let the progress overlay paint before the page blocks.
  await nextFrame();
  return reconstruct(input, onProgress);
}

function toView(p: Photo & { flip?: boolean; shapeOnly?: boolean }): ViewInput {
  return { image: p.image, mask: p.mask!, depth: p.depth, depthRect: p.depthRect, flip: p.flip, geometryOnly: p.shapeOnly };
}

async function generate(opts: { quick?: boolean } = {}) {
  const front = state.front;
  if (!front || state.busy) return;
  state.busy = true;
  state.dirty = false;
  updateModelState();
  const gen = ++state.generation;
  const btn = $('generate-btn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  if (!opts.quick) {
    progress.show('Building your 3D model');
    // The intro would show around the dialog.
    $('empty-state').hidden = true;
  }
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
      step(state.sampleId ? 'Picking reference views from the sample images' : 'Looking up reference views of this object on the web');
      if (sampleRanking) await sampleRanking;
      let searched = true;
      if (!state.candidates.length || !state.rankMode) searched = await runSearch();
      const picked = await autoPick();
      if (picked.length) step(`Using ${state.sampleId ? 'sample' : 'web'} images for: ${describeViews(picked)}`);
      else if (DEMO && !searched) progress.warn(`${DEMO_SEARCH_NOTE} Using shape priors for the hidden sides; you can drop views in manually.`);
      else progress.warn(`No confident matches for the back/sides ${state.sampleId ? 'among the sample images' : 'on the web'} — using shape priors instead. You can pick or drop views manually.`);
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
    if (!opts.quick) {
      setTimeout(() => {
        $('progress').hidden = true;
        if (!state.result) $('empty-state').hidden = false;
      }, 4000);
    }
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = 'Generate 3D model';
    updateModelState();
    if (state.dirty) scheduleRegenerate();
  }
}

function showResult(result: MeshResult) {
  state.result = result;
  state.atlasCanvas = rgbaToCanvas(result.atlas);
  if (!viewer) {
    viewer = new Viewer($('viewer'));
    viewer.compareInsets = stageInsets;
  }
  viewer.setModel(result, state.atlasCanvas);
  viewer.setShading(currentShading);
  viewer.setWireframe($('wire-btn').getAttribute('aria-pressed') === 'true');
  $('empty-state').hidden = true;
  $('toolbar').hidden = false;
  $('exports').hidden = false;
  updateModelState();
  const s = result.stats;
  const shapeOnly = s.shapeOnlyRefs ?? [];
  const all = [...s.usedRefs, ...shapeOnly];
  const sample = all.length > 0 && all.every((v) => state.refs[v]?.sample);
  const views = s.usedRefs.length ? s.usedRefs.join(', ') : 'none';
  const shapeNote = shapeOnly.length ? ` · <span title="Side views of which it is unclear which end of the object they show set the depth only, not the texture.">shape only: <b>${shapeOnly.join(', ')}</b></span>` : '';
  $('stats').hidden = false;
  $('stats').innerHTML = `<b>${s.triangles.toLocaleString()}</b> triangles · depth: <b>${s.usedDepth ? 'AI' : 'silhouette'}</b> · reference views${sample ? ' (sample)' : ''}: <b>${views}</b>${shapeNote} · back: <b>${s.backShape}/${s.backTexture}</b> · ${
    s.watertight ? '<span class="ok">watertight ✓</span>' : 'open mesh'
  }`;
}

// ---------------------------------------------------------------------------
// Viewer toolbar + export

let currentShading: Shading = 'lit';

/**
 * After a new photo is loaded the viewer still shows the previous photo's model until Generate builds one:
 * it is dimmed, and comparing or exporting it is disabled.
 */
function updateModelState() {
  const stale = !state.result && !!viewer;
  $('stage').classList.toggle('stale', stale);
  const note = $('stale-note');
  note.hidden = !stale;
  note.innerHTML =
    state.busy || buildQueued
      ? 'This is the previous photo’s model. Building one for the new photo…'
      : 'This is the previous photo’s model. Press <b>Generate</b> to build one for the new photo.';
  const compare = $('compare-btn') as HTMLButtonElement;
  if (stale && compare.getAttribute('aria-pressed') === 'true') {
    compare.setAttribute('aria-pressed', 'false');
    $('compare-bar').hidden = true;
    viewer?.setCompare(false);
  }
  compare.disabled = stale;
  document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach((b) => (b.disabled = stale));
}

/** How far the toolbar and stats (top) and the compare and export bars (bottom) reach into the 3D view; on phones they sit outside it. */
function stageInsets() {
  const view = $('viewer').getBoundingClientRect();
  let top = 0;
  let bottom = 0;
  for (const id of ['toolbar', 'stats']) {
    const r = $(id).getBoundingClientRect();
    if (r.height) top = Math.max(top, r.bottom - view.top);
  }
  for (const id of ['compare-bar', 'exports']) {
    const r = $(id).getBoundingClientRect();
    if (r.height) bottom = Math.max(bottom, view.bottom - r.top);
  }
  return { top, bottom };
}

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
    // Shown first, so the photo is laid out clear of it.
    $('compare-bar').hidden = !on;
    viewer?.setCompare(on);
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
        b.disabled = !state.result;
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
    if (d.kind !== 'result') leaveSample();
    await setFront(loaded.image, loaded.name, loaded.source);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function showSearchBadge(health: Awaited<ReturnType<typeof apiHealth>>) {
  const sb = $('search-badge');
  if (health?.providers?.length) {
    sb.textContent = `Web search: ${health.providers.length} source${health.providers.length > 1 ? 's' : ''}`;
    sb.title = health.providers.map((p) => p.label).join(', ');
    sb.className = 'badge on';
  } else if (DEMO) {
    sb.textContent = 'Web search: samples';
    sb.className = 'badge';
    sb.title = DEMO_SEARCH_NOTE;
    const status = $('search-status');
    if (!status.textContent) status.textContent = DEMO_SEARCH_NOTE;
  } else {
    sb.textContent = 'Web search: offline';
    sb.className = 'badge warn';
    sb.title = 'The search API is not reachable. Use “Search in your own browser” and drag images in.';
  }
}

async function boot() {
  buildSettings();
  renderSlots();
  wireInputs();
  wireToolbar();
  updateBrowserLinks();
  setAiBadge(state.ai.enabled ? 'AI: on' : 'AI: off', state.ai.enabled ? 'on' : '');
  if (DEMO) $('ai-badge').title = DEMO_AI_NOTE;
  $('export-note').hidden = !DEMO;
  $('samples-note').hidden = !DEMO;
  // The hosted demo has no search server; do not even probe the host for one.
  healthCheck = DEMO ? Promise.resolve(null) : apiHealth();
  void healthCheck.then(showSearchBadge);
  state.samples = await loadSamples();
  renderSamples();
  // ?sample=<id> opens a sample directly; the demo opens with the first one, already built.
  const wanted = new URLSearchParams(location.search).get('sample');
  const sample = state.samples.find((s) => s.id === wanted) ?? (DEMO ? state.samples[0] : undefined);
  if (sample && !state.front) await openSample(sample);
}

// A small hook for automated tests and recordings; `ready` resolves once the page has finished opening.
(window as unknown as { __trueform: unknown }).__trueform = {
  state,
  generate,
  setFront,
  loadSample,
  get viewer() {
    return viewer;
  },
  ready: boot(),
};
