// Redaction runs before anything reaches a model. Placeholders are typed so extraction
// can still reason about "there was a token here" without ever seeing it.

const RULES: { name: string; re: RegExp }[] = [
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws_key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'aws_secret', re: /(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}/gi },
  { name: 'github_token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{80,})\b/g },
  { name: 'slack_token', re: /\bxox[abpres]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openai_key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe_key', re: /\b[sr]k_(live|test)_[0-9a-zA-Z]{20,}\b/g },
  { name: 'supabase_publishable', re: /\bsb_(publishable|secret)_[A-Za-z0-9_-]{16,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'bearer', re: /(?<=Bearer\s)[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: 'basic_auth_url', re: /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g },
  { name: 'env_assignment', re: /(?<=\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*["']?)[^\s"']{8,}/g },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;

function shannon(s: string): number {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export interface RedactionReport { replaced: Record<string, number>; total: number }

export function redact(text: string, opts: { emails?: boolean } = {}): { text: string; report: RedactionReport } {
  const report: RedactionReport = { replaced: {}, total: 0 };
  let out = text;
  for (const r of RULES) {
    if (r.name === 'email' && opts.emails === false) continue;
    out = out.replace(r.re, () => { report.replaced[r.name] = (report.replaced[r.name] ?? 0) + 1; report.total++; return `<SECRET:${r.name}>`; });
  }
  // high-entropy long tokens (skip obvious paths/hashes-of-known-shape like git shas which are hex 40)
  out = out.replace(HIGH_ENTROPY, (m) => {
    if (/^[0-9a-f]{40}$/i.test(m) || /^[0-9a-f]{64}$/i.test(m)) return m; // git/sha256 — not secrets
    if (m.includes('/') && m.split('/').length > 2) return m; // looks like a path
    if (shannon(m) < 4.2) return m;
    report.replaced['high_entropy'] = (report.replaced['high_entropy'] ?? 0) + 1; report.total++;
    return '<SECRET:high_entropy>';
  });
  return { text: out, report };
}

/** Redact every string field of a canonical event in place-ish (returns new object). */
export function redactDeep<T>(v: T, report?: RedactionReport): T {
  if (typeof v === 'string') {
    const r = redact(v);
    if (report) { report.total += r.report.total; for (const [k, n] of Object.entries(r.report.replaced)) report.replaced[k] = (report.replaced[k] ?? 0) + n; }
    return r.text as unknown as T;
  }
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, report)) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = redactDeep(x, report);
    return o as T;
  }
  return v;
}
