// Text embeddings for semantic search (AI Vector Search in Oracle 23ai).
// Uses the all-MiniLM-L6-v2 sentence-transformer (384 dimensions) through transformers.js when
// it is installed and the model can be downloaded once; otherwise a built-in embedding of words,
// word stems, character trigrams and a small warehouse thesaurus (also 384 dimensions), so the
// feature works offline. Every stored vector records which model made it.

export const DIMS = 384;
export const MINILM = 'all-MiniLM-L6-v2';
export const BUILTIN = 'cargoverse-lexical-384';

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

// words that mean the same thing in damage reports and product descriptions
const THESAURUS: string[][] = [
  ['broken', 'break', 'cracked', 'crack', 'shattered', 'smashed', 'snapped', 'split', 'damaged', 'damage', 'crushed', 'dented', 'collapsed'],
  ['wet', 'water', 'rain', 'soaked', 'leak', 'leaking', 'damp', 'moisture', 'mould', 'mouldy', 'mold', 'flood'],
  ['hot', 'heat', 'warm', 'temperature', 'excursion', 'degrees', 'overheated', 'thermal', 'heater'],
  ['cold', 'refrigerated', 'fridge', 'chilled', 'reefer', 'freezer', 'cooler', 'ice', 'frozen'],
  ['glass', 'diffuser', 'panel', 'light', 'lighting', 'lamp', 'led', 'fragile'],
  ['short', 'missing', 'shortage', 'count', 'discrepancy', 'fewer', 'lost'],
  ['label', 'barcode', 'labelled', 'mislabelled', 'wrong', 'mismatch', 'sku'],
  ['pallet', 'deck', 'board', 'base', 'forks', 'forklift', 'tine'],
  ['wrap', 'shrink', 'wrapped', 'loose', 'shifted', 'spilled', 'fell', 'tipped'],
  ['expired', 'expiry', 'date', 'old', 'rotation', 'fefo', 'fifo'],
  ['medicine', 'medical', 'pharma', 'pharmaceutical', 'insulin', 'pens', 'injector', 'pharmacy', 'drug'],
  ['gloves', 'glove', 'nitrile', 'ppe', 'protective'],
  ['box', 'boxes', 'carton', 'cartons', 'cardboard', 'packaging', 'packing'],
  ['chair', 'furniture', 'armrest', 'wheels', 'assembly'],
  ['helmet', 'hard', 'hat', 'head', 'safety'],
  ['contaminated', 'contamination', 'dirty', 'exposed', 'punctured', 'torn', 'ripped', 'nail'],
];
const CONCEPT = new Map<string, string>();
THESAURUS.forEach((group, i) => group.forEach((w) => CONCEPT.set(w, `#${i}`)));

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');
}

/** The built-in embedding: signed feature hashing of words, stems, concepts and trigrams, L2-normalised. */
export function lexicalEmbedding(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const add = (feat: string, weight: number) => {
    const h = fnv(feat);
    v[h % DIMS] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  const words = text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  for (const w of words) {
    add(`w:${stem(w)}`, 1);
    const c = CONCEPT.get(w) ?? CONCEPT.get(stem(w));
    if (c) add(`c:${c}`, 2.2);
    const p = ` ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) add(`t:${p.slice(i, i + 3)}`, 0.35);
  }
  for (let i = 0; i + 1 < words.length; i++) add(`b:${stem(words[i])}_${stem(words[i + 1])}`, 0.6);
  const n = Math.hypot(...v) || 1;
  return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
}

export function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

export class Embedder {
  model = BUILTIN;
  private extractor: Extractor | null = null;
  readonly ready: Promise<void>;
  note: string | null = null;

  constructor(cacheDir: string, tryModel = process.env.EMBED_MODEL !== 'builtin') {
    this.ready = tryModel ? this.load(cacheDir) : Promise.resolve();
  }

  private async load(cacheDir: string): Promise<void> {
    try {
      const pkg = '@huggingface/transformers';
      const mod = (await import(pkg)) as { pipeline: (task: string, model: string, opts?: unknown) => Promise<Extractor>; env: { cacheDir: string } };
      mod.env.cacheDir = cacheDir;
      const ex = await Promise.race([
        mod.pipeline('feature-extraction', `Xenova/${MINILM}`, { dtype: 'q8' }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('model download timed out')), 120000)),
      ]);
      await ex(['warmup'], { pooling: 'mean', normalize: true });
      this.extractor = ex;
      this.model = MINILM;
    } catch (e) {
      const msg = String((e as Error).message ?? e).split('\n')[0];
      this.note = /Cannot find (package|module)/.test(msg)
        ? 'The sentence-transformer is not installed (npm install @huggingface/transformers); using the built-in embedding.'
        : `Could not load ${MINILM} (${msg.slice(0, 120)}); using the built-in embedding.`;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ready;
    if (this.extractor) {
      const out = await this.extractor(texts, { pooling: 'mean', normalize: true });
      return out.tolist().map((v) => v.map((x) => Math.round(x * 1e6) / 1e6));
    }
    return texts.map(lexicalEmbedding);
  }
}
