import type { SearchResult } from './client';

export interface SampleReference {
  id: string;
  title: string;
  file: string;
  hint: SearchResult['hint'];
  source: string;
}

export interface Sample {
  id: string;
  title: string;
  /** What a user would type to search the web for this object. */
  query: string;
  photo: string;
  /** Reference candidates as a web search would return them, distractors included. */
  references: SampleReference[];
}

/** Relative to the page, so builds hosted under a sub-path find it. */
export const MANIFEST_URL = 'samples/manifest.json';

const HINTS = new Set<string>(['any', 'back', 'side', 'top']);

const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Only paths relative to the page: absolute URLs would break sub-path hosting or leave the origin. */
const relativePath = (v: unknown): v is string => str(v) && !/^([a-z][a-z\d+.-]*:|\/)/i.test(v.trim());

/** Validates a parsed manifest, dropping malformed entries instead of rejecting the whole file. */
export function parseManifest(raw: unknown): Sample[] {
  const list = (raw as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(list)) return [];
  const samples: Sample[] = [];
  for (const s of list) {
    if (!s || !str(s.id) || !str(s.title) || !relativePath(s.photo)) continue;
    const references: SampleReference[] = [];
    for (const r of Array.isArray(s.references) ? s.references : []) {
      if (!r || !relativePath(r.file)) continue;
      references.push({
        id: str(r.id) ? r.id : `${s.id}:${references.length}`,
        title: str(r.title) ? r.title : s.title,
        file: r.file.trim(),
        hint: HINTS.has(r.hint) ? r.hint : 'any',
        source: str(r.source) ? r.source : 'Sample',
      });
    }
    samples.push({ id: s.id, title: s.title, query: str(s.query) ? s.query : s.title, photo: s.photo.trim(), references });
  }
  return samples;
}

/** The bundled samples, or none when this build ships without them. */
export async function loadSamples(url = MANIFEST_URL): Promise<Sample[]> {
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return parseManifest(await res.json());
  } catch {
    // missing manifest, or a host that answers with its own HTML page
    return [];
  }
}

/** Sample references in the shape web search results have, so ranking and auto-pick treat them the same. */
export function sampleResults(sample: Sample): SearchResult[] {
  return sample.references.map((r) => ({ id: r.id, title: r.title, thumbnail: r.file, url: r.file, source: r.source, hint: r.hint }));
}
