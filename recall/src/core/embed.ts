// Embedder interface with a zero-dependency default (feature-hashed word+bigram vectors).
// A transformer embedder can be plugged in later behind the same interface without touching callers.

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(text: string): number[];
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
  embed(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const toks = tokenize(text);
    const grams = [...toks];
    for (let i = 0; i + 1 < toks.length; i++) grams.push(toks[i] + '_' + toks[i + 1]);
    for (const g of grams) {
      const h = fnv1a(g);
      const idx = h % this.dim;
      const sign = (h >>> 31) === 0 ? 1 : -1; // never both 0
      v[idx] += sign * (g.includes('_') ? 0.6 : 1);
    }
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  }
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const defaultEmbedder: Embedder = new HashingEmbedder(512);
