// Embedders. Two implementations behind one async interface:
//   - HashingEmbedder: zero-dependency feature-hashed word+bigram vectors (fallback; lexical)
//   - TransformerEmbedder: local ONNX model via @huggingface/transformers (default: Xenova/bge-small-en-v1.5, 384-d)
// Entities record which embedder produced their vector; cosine across different embedders is 0 (graceful degrade).

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
  embedMany(texts: string[]): Promise<number[][]>;
}

const STOP = new Set('the a an and or of to in on for with is are was were be been it this that as at by from into your you we i our my'.split(' '));

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`'"()[\]{}<>,;:!?]/g, ' ')
    .split(/[\s/\\.=+*&|^%$#@~-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export class HashingEmbedder implements Embedder {
  readonly name = 'hashing-v1';
  constructor(readonly dim = 512) {}
  embedSync(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const toks = tokenize(text);
    const grams = [...toks];
    for (let i = 0; i + 1 < toks.length; i++) grams.push(toks[i] + '_' + toks[i + 1]);
    for (const g of grams) {
      const h = fnv1a(g);
      const idx = h % this.dim;
      const sign = (h >>> 31) === 0 ? 1 : -1;
      v[idx] += sign * (g.includes('_') ? 0.6 : 1);
    }
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  }
  async embed(text: string) { return this.embedSync(text); }
  async embedMany(texts: string[]) { return texts.map((t) => this.embedSync(t)); }
}

export const DEFAULT_TRANSFORMER_MODEL = process.env.RECALL_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5';

export class TransformerEmbedder implements Embedder {
  readonly name: string;
  dim = 384;
  private pipe: Promise<(texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>> | null = null;
  constructor(readonly model = DEFAULT_TRANSFORMER_MODEL) { this.name = 'transformer:' + model; }
  private load() {
    if (!this.pipe) {
      this.pipe = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        // keep model cache under ~/.recall so it survives package upgrades
        (env as unknown as { cacheDir?: string }).cacheDir = process.env.RECALL_MODEL_CACHE ?? `${process.env.HOME ?? '.'}/.recall/models`;
        const p = await pipeline('feature-extraction', this.model, { dtype: 'q8' } as never);
        return p as unknown as (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;
      })();
    }
    return this.pipe;
  }
  async warm() { await this.load(); }
  async embedMany(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const p = await this.load();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32).map((t) => t.slice(0, 2000));
      const r = await p(batch, { pooling: 'cls', normalize: true });
      out.push(...r.tolist());
    }
    if (out[0]) this.dim = out[0].length;
    return out;
  }
  async embed(text: string) { return (await this.embedMany([text]))[0]; }
}

export function cosine(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const hashingEmbedder = new HashingEmbedder(512);

/** Choose the embedder from config/env: RECALL_EMBEDDER=hashing|transformer (default transformer). */
export function pickEmbedder(): Embedder {
  const pref = process.env.RECALL_EMBEDDER ?? 'transformer';
  return pref === 'hashing' ? hashingEmbedder : new TransformerEmbedder();
}
