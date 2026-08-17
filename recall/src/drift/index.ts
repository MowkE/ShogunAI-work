// Doc-drift projection: does the documentation still match the code that just changed?
//   1. SymbolIndex — lightweight regex symbol extraction (TS/JS, Python, Go, Rust, Swift, Java/Kotlin, Ruby)
//   2. MarkdownIndex — sections of every *.md with the symbols/paths they mention
//   3. Changed set — files/hunks from `git diff` (base..HEAD, --staged, or a PR via gh)
//   4. Findings — deterministic: stale mentions (docs reference a path/symbol that no longer exists),
//      undocumented changed exports, sections touching changed symbols (review candidates);
//      optional LLM consistency check per (section, changed symbols) using structured output.
// Output: markdown report / JSON; `--comment` posts to the PR with gh.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { JsonModel } from '../extract/model.js';

export interface Symbol { file: string; name: string; kind: string; line: number; exported: boolean }
export interface DocSection { file: string; heading: string; level: number; startLine: number; endLine: number; text: string; mentions: { symbols: string[]; paths: string[] } }
export interface Finding {
  kind: 'stale_path' | 'stale_symbol' | 'undocumented_symbol' | 'review_section' | 'inconsistent';
  severity: 'high' | 'medium' | 'low';
  doc?: { file: string; heading: string; line: number };
  code?: { file?: string; symbol?: string; line?: number };
  message: string; suggestion?: string;
}

const IGNORE_DIR = /(^|\/)(node_modules|dist|build|vendor|\.git|\.next|coverage|target|__pycache__|\.venv|venv|\.recall)(\/|$)/;
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.swift', '.java', '.kt', '.rb']);

export function walkFiles(root: string, pred: (p: string) => boolean, max = 20000): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    if (out.length >= max) return;
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name); const rel = relative(root, p);
      if (IGNORE_DIR.test(rel + (e.isDirectory() ? '/' : ''))) continue;
      if (e.isDirectory()) rec(p); else if (pred(rel)) out.push(rel);
    }
  };
  rec(root); return out;
}

// ---------- symbols ----------

const PATTERNS: Record<string, { re: RegExp; kind: string; exported: (m: RegExpMatchArray) => boolean }[]> = {
  ts: [
    { re: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm, kind: 'function', exported: (m) => !!m[1] },
    { re: /^\s*(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: 'class', exported: (m) => !!m[1] },
    { re: /^\s*(export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, kind: 'type', exported: (m) => !!m[1] },
    { re: /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm, kind: 'function', exported: (m) => !!m[1] },
    { re: /^\s*(export\s+)(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm, kind: 'const', exported: () => true },
  ],
  py: [
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, kind: 'function', exported: (m) => !m[1].startsWith('_') },
    { re: /^class\s+([A-Za-z_]\w*)/gm, kind: 'class', exported: (m) => !m[1].startsWith('_') },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: 'function', exported: (m) => /^[A-Z]/.test(m[1]) },
    { re: /^type\s+([A-Za-z_]\w*)/gm, kind: 'type', exported: (m) => /^[A-Z]/.test(m[1]) },
  ],
  rs: [
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, kind: 'function', exported: (m) => !!m[1] },
    { re: /^\s*(pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm, kind: 'type', exported: (m) => !!m[1] },
  ],
  swift: [
    { re: /^\s*(public\s+|open\s+)?(?:static\s+)?func\s+([A-Za-z_]\w*)/gm, kind: 'function', exported: (m) => true },
    { re: /^\s*(public\s+|open\s+)?(?:final\s+)?(?:class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)/gm, kind: 'type', exported: () => true },
  ],
  java: [
    { re: /^\s*(public\s+)?(?:abstract\s+|final\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm, kind: 'type', exported: (m) => !!m[1] },
    { re: /^\s*(public\s+)(?:static\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\(/gm, kind: 'method', exported: () => true },
  ],
  rb: [
    { re: /^\s*()def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/gm, kind: 'method', exported: () => true },
    { re: /^\s*()(?:class|module)\s+([A-Za-z_][\w:]*)/gm, kind: 'type', exported: () => true },
  ],
};
const LANG: Record<string, string> = { '.ts': 'ts', '.tsx': 'ts', '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.py': 'py', '.go': 'go', '.rs': 'rs', '.swift': 'swift', '.java': 'java', '.kt': 'java', '.rb': 'rb' };

export function extractSymbols(file: string, src: string): Symbol[] {
  const lang = LANG[extname(file)]; if (!lang) return [];
  const out: Symbol[] = []; const seen = new Set<string>();
  for (const p of PATTERNS[lang]) {
    for (const m of src.matchAll(p.re)) {
      const name = m[2] ?? m[1]; if (!name || name.length < 3 || seen.has(name)) continue;
      seen.add(name);
      out.push({ file, name, kind: p.kind, line: src.slice(0, m.index).split('\n').length, exported: p.exported(m) });
    }
  }
  return out;
}

/** Every identifier-looking token in the codebase (declarations, properties, params). Bounded; used for stale-symbol checks. */
export function indexIdentifiers(root: string, maxFiles = 4000): Set<string> {
  const ids = new Set<string>();
  const files = walkFiles(root, (p) => CODE_EXT.has(extname(p)) || /\.(json|yaml|yml|toml|sql|css|html|sh)$/.test(p)).slice(0, maxFiles);
  for (const f of files) {
    try { const st = statSync(join(root, f)); if (st.size > 400_000) continue; const src = readFileSync(join(root, f), 'utf-8'); for (const m of src.matchAll(/[A-Za-z_$][\w$]{2,}/g)) ids.add(m[0]); } catch { /* skip */ }
  }
  return ids;
}

/** Did this identifier ever appear in the codebase? (git pickaxe; bounded by caller) */
export function identifierExistedInGit(root: string, name: string): boolean {
  const specs = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.py', '*.go', '*.rs', '*.swift', '*.java', '*.kt', '*.rb'];
  try { return execFileSync('git', ['-C', root, 'log', '-S', name, '--oneline', '-1', '--', ...specs], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; } catch { return false; }
}

/** Did this path ever exist in git history? (cheap-ish; cached per call site) */
export function existedInGit(root: string, path: string): boolean {
  try { return execFileSync('git', ['-C', root, 'log', '--oneline', '-1', '--', path], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0; } catch { return false; }
}

export function indexSymbols(root: string, files?: string[]): Symbol[] {
  const list = files ?? walkFiles(root, (p) => CODE_EXT.has(extname(p)));
  const out: Symbol[] = [];
  for (const f of list) { const abs = join(root, f); if (!existsSync(abs)) continue; try { if (statSync(abs).size > 512_000) continue; out.push(...extractSymbols(f, readFileSync(abs, 'utf-8'))); } catch { /* skip */ } }
  return out;
}

// ---------- docs ----------

export function indexDocs(root: string, symbolNames: Set<string>, knownPaths: Set<string>): DocSection[] {
  const files = walkFiles(root, (p) => p.endsWith('.md') || p.endsWith('.mdx'));
  const out: DocSection[] = [];
  const pathRe = /(?:^|[\s`("'])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,6}|[\w-]+\.(?:ts|tsx|js|py|go|rs|swift|java|kt|rb|md|json|yaml|yml|toml))(?=$|[\s`)"',.:;])/g;
  for (const f of files) {
    let src: string; try { src = readFileSync(join(root, f), 'utf-8'); } catch { continue; }
    const lines = src.split('\n');
    let cur: DocSection | null = null; let inFence = false;
    const flush = (end: number) => { if (cur) { cur.endLine = end; cur.text = lines.slice(cur.startLine - 1, end).join('\n'); annotate(cur); out.push(cur); } };
    const annotate = (s: DocSection) => {
      const syms = new Set<string>(); const paths = new Set<string>();
      for (const m of s.text.matchAll(/`([^`\n]{3,80})`|\b([A-Za-z_$][\w$]{3,})\b/g)) {
        const code = m[1]; const word = m[2];
        const codeish = (w: string) => symbolNames.has(w) && (/[a-z][A-Z]|_/.test(w) || w.length >= 7) && !/^(string|number|boolean|object|default|export|import|return|function|module|record|result|results|status|config|options|params|value|values|error|errors|message|messages|content|context|version|latest|install|update|delete|create|remove|search|render|handle|process)$/i.test(w);
        if (code) { for (const w of code.split(/[^\w$]+/)) if (codeish(w)) syms.add(w); }
        else if (word && codeish(word) && /[A-Z_]/.test(word.slice(1))) syms.add(word); // camelCase/snake symbols in prose only
      }
      for (const m of s.text.matchAll(pathRe)) { const p = m[1].replace(/^\.\//, ''); if (knownPaths.has(p) || /^[\w./-]+\/[\w.-]+\.[a-z]+$/.test(p)) paths.add(p); }
      s.mentions = { symbols: [...syms], paths: [...paths] };
    };
    lines.forEach((ln, i) => {
      if (/^\s*```/.test(ln)) inFence = !inFence;
      const h = !inFence && ln.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) { flush(i); cur = { file: f, heading: h[2].trim(), level: h[1].length, startLine: i + 1, endLine: i + 1, text: '', mentions: { symbols: [], paths: [] } }; }
      else if (!cur && ln.trim()) { cur = { file: f, heading: basename(f), level: 0, startLine: i + 1, endLine: i + 1, text: '', mentions: { symbols: [], paths: [] } }; }
    });
    flush(lines.length);
  }
  return out;
}

// ---------- changed set ----------

export interface ChangedFile { file: string; hunks: { start: number; end: number }[]; status: 'M' | 'A' | 'D' | 'R' }

export function changedFromGit(root: string, opts: { base?: string; staged?: boolean } = {}): ChangedFile[] {
  const args = ['-C', root, 'diff', '-U0', '--no-color'];
  if (opts.staged) args.push('--cached'); else if (opts.base) args.push(`${opts.base}...HEAD`); else args.push('HEAD~1');
  let out = ''; try { out = execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }); } catch { return []; }
  const files: ChangedFile[] = []; let cur: ChangedFile | null = null;
  for (const ln of out.split('\n')) {
    const h = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (h) { cur = { file: h[2], hunks: [], status: 'M' }; files.push(cur); continue; }
    if (!cur) continue;
    if (/^new file mode/.test(ln)) cur.status = 'A'; else if (/^deleted file mode/.test(ln)) cur.status = 'D'; else if (/^rename to/.test(ln)) cur.status = 'R';
    const hh = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hh) { const s = Number(hh[1]); const n = hh[2] === undefined ? 1 : Number(hh[2]); cur.hunks.push({ start: s, end: s + Math.max(0, n - 1) }); }
  }
  return files;
}

export function changedFromPR(root: string, prNumber: number): ChangedFile[] {
  try {
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!remote) return [];
    const files = JSON.parse(execFileSync('gh', ['api', `repos/${remote[1]}/${remote[2]}/pulls/${prNumber}/files?per_page=100`], { encoding: 'utf-8' })) as { filename: string; status: string; patch?: string }[];
    return files.map((f) => {
      const hunks: { start: number; end: number }[] = [];
      for (const m of (f.patch ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) { const s = Number(m[1]); const n = m[2] === undefined ? 1 : Number(m[2]); hunks.push({ start: s, end: s + Math.max(0, n - 1) }); }
      return { file: f.filename, hunks, status: f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M' } as ChangedFile;
    });
  } catch { return []; }
}

// ---------- analysis ----------

export interface DriftReport { changedFiles: number; changedSymbols: Symbol[]; findings: Finding[]; sectionsReviewed: number; llmChecked: number; costUsd: number }

export async function analyzeDrift(root: string, changed: ChangedFile[], opts: { model?: JsonModel | null; maxLlm?: number; onProgress?: (m: string) => void } = {}): Promise<DriftReport> {
  const log = opts.onProgress ?? (() => {});
  const allSymbols = indexSymbols(root);
  const symbolNames = new Set(allSymbols.map((s) => s.name));
  const knownPaths = new Set(walkFiles(root, () => true, 50000));
  const docs = indexDocs(root, symbolNames, knownPaths);
  const identifiers = indexIdentifiers(root);
  const resolvesFrom = (docFile: string, p: string): boolean => {
    // exists relative to repo root, to the doc's directory, or to any ancestor of the doc's directory (monorepo-style docs)
    if (knownPaths.has(p) || existsSync(join(root, p))) return true;
    const parts = docFile.split('/'); parts.pop();
    while (parts.length) { const cand = join(root, ...parts, p); if (existsSync(cand)) return true; parts.pop(); }
    return false;
  };
  const isRepoSection = (sec: DocSection) => sec.mentions.symbols.length > 0 || sec.mentions.paths.some((p) => resolvesFrom(sec.file, p));
  const findings: Finding[] = [];
  const changedSet = new Set(changed.map((c) => c.file));

  // symbols in changed files whose lines intersect a hunk (or all symbols if no hunk info / new file)
  const changedSymbols: Symbol[] = [];
  for (const c of changed) {
    if (c.status === 'D') continue;
    const syms = allSymbols.filter((s) => s.file === c.file);
    for (const s of syms) {
      const hit = !c.hunks.length || c.status === 'A' || c.hunks.some((h) => Math.abs(h.start - s.line) <= 40 || (s.line >= h.start && s.line <= h.end));
      if (hit) changedSymbols.push(s);
    }
  }
  const changedNames = new Set(changedSymbols.map((s) => s.name));

  // 1) stale mentions: docs referencing paths that used to exist (git history) but are gone/renamed now
  const seenStale = new Set<string>();
  for (const sec of docs) {
    for (const p of sec.mentions.paths) {
      if (resolvesFrom(sec.file, p) || /^(https?:|www\.|[a-z]+:\/\/)/.test(p)) continue;
      const wasDeletedNow = changed.some((c) => (c.status === 'D' || c.status === 'R') && c.file === p);
      const historical = wasDeletedNow || existedInGit(root, p);
      if (!historical) continue; // hypothetical/example paths in prose are not drift
      const key = `${sec.file}|${p}`; if (seenStale.has(key)) continue; seenStale.add(key);
      findings.push({ kind: 'stale_path', severity: wasDeletedNow ? 'high' : 'medium', doc: { file: sec.file, heading: sec.heading, line: sec.startLine }, code: { file: p }, message: `\`${sec.file}\` § "${sec.heading}" references \`${p}\`, which existed in git history but is gone (deleted or renamed).`, suggestion: 'Update the path or remove the reference.' });
    }
  }
  // stale symbols: code-span identifiers in repo-related sections that appear nowhere in the codebase (declarations, properties, or any token)
  const seenSym = new Set<string>();
  for (const sec of docs) {
    if (!isRepoSection(sec)) continue;
    for (const m of sec.text.matchAll(/`([A-Za-z_$][\w$]{4,})(?:\(\))?`/g)) {
      const name = m[1];
      if (identifiers.has(name) || symbolNames.has(name)) continue;
      if (!/[a-z][A-Z]|_/.test(name)) continue; // camelCase / snake_case only — prose words in backticks are not symbols
      const key = `${sec.file}|${name}`; if (seenSym.has(key)) continue; seenSym.add(key);
      if (seenSym.size > 60 || !identifierExistedInGit(root, name)) continue; // only identifiers that used to be in this codebase = renamed/removed
      findings.push({ kind: 'stale_symbol', severity: 'medium', doc: { file: sec.file, heading: sec.heading, line: sec.startLine }, code: { symbol: name }, message: `\`${sec.file}\` § "${sec.heading}" mentions \`${name}\`, which was removed or renamed in the codebase.`, suggestion: 'Rename the reference or remove it.' });
    }
  }
  // 2) undocumented changed exports
  const documented = new Set(docs.flatMap((d) => d.mentions.symbols));
  const docPathMentions = new Set(docs.flatMap((d) => d.mentions.paths));
  for (const s of changedSymbols) {
    if (!s.exported || s.name.length < 4) continue;
    if (documented.has(s.name)) continue;
    if (/\.(test|spec)\.|__tests__|\/test\//.test(s.file)) continue;
    findings.push({ kind: 'undocumented_symbol', severity: docPathMentions.has(s.file) ? 'medium' : 'low', code: { file: s.file, symbol: s.name, line: s.line }, message: `Changed export \`${s.name}\` (${s.kind}) in \`${s.file}\` has no documentation mention.`, suggestion: 'Add a line to the relevant doc section, or mark it internal.' });
  }
  // 3) sections that mention changed symbols/paths → review candidates (+ optional LLM check)
  const review = docs.filter((d) => d.mentions.symbols.some((s) => changedNames.has(s)) || d.mentions.paths.some((p) => changedSet.has(p)));
  let llmChecked = 0, costUsd = 0;
  for (const sec of review) {
    const syms = sec.mentions.symbols.filter((s) => changedNames.has(s));
    const paths = sec.mentions.paths.filter((p) => changedSet.has(p));
    const what = [...syms.map((s) => '`' + s + '`'), ...paths.map((p) => '`' + p + '`')].slice(0, 6).join(', ');
    if (opts.model && llmChecked < (opts.maxLlm ?? 8)) {
      try {
        const codeCtx = [...new Set([...changedSymbols.filter((s) => syms.includes(s.name)).map((s) => s.file), ...paths])].slice(0, 3).map((f) => { try { return `--- ${f} ---\n` + readFileSync(join(root, f), 'utf-8').slice(0, 6000); } catch { return ''; } }).join('\n');
        const r = await opts.model.json({ system: 'You check whether a documentation section is still consistent with the current code. Be strict but only report concrete contradictions (wrong names, flags, paths, behavior, defaults, steps). Ignore style.', user: `DOC SECTION (${sec.file} § ${sec.heading}):\n${sec.text.slice(0, 5000)}\n\nCURRENT CODE:\n${codeCtx.slice(0, 14000)}`, schema: { type: 'object', additionalProperties: false, required: ['consistent', 'issues'], properties: { consistent: { type: 'boolean' }, issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote', 'problem', 'suggestedFix'], properties: { quote: { type: 'string' }, problem: { type: 'string' }, suggestedFix: { type: 'string' } } } } } } });
        llmChecked++; costUsd += r.costUsd;
        const d = r.data as { consistent: boolean; issues: { quote: string; problem: string; suggestedFix: string }[] };
        if (!d.consistent) for (const is of d.issues.slice(0, 5)) findings.push({ kind: 'inconsistent', severity: 'high', doc: { file: sec.file, heading: sec.heading, line: sec.startLine }, message: `\`${sec.file}\` § "${sec.heading}": ${is.problem} — "${is.quote.slice(0, 120)}"`, suggestion: is.suggestedFix });
        else findings.push({ kind: 'review_section', severity: 'low', doc: { file: sec.file, heading: sec.heading, line: sec.startLine }, message: `\`${sec.file}\` § "${sec.heading}" mentions ${what} — checked, still consistent.` });
        log(`checked ${sec.file} § ${sec.heading}: ${d.consistent ? 'ok' : d.issues.length + ' issues'}`);
        continue;
      } catch (e) { log(`llm check failed: ${(e as Error).message.slice(0, 100)}`); }
    }
    findings.push({ kind: 'review_section', severity: 'medium', doc: { file: sec.file, heading: sec.heading, line: sec.startLine }, message: `\`${sec.file}\` § "${sec.heading}" mentions ${what}, which changed — review for drift.` });
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { changedFiles: changed.length, changedSymbols, findings, sectionsReviewed: review.length, llmChecked, costUsd };
}

export function renderReport(r: DriftReport, opts: { title?: string } = {}): string {
  const L: string[] = [];
  L.push(`## ${opts.title ?? 'Recall doc-drift report'}`);
  L.push(`${r.changedFiles} changed files · ${r.changedSymbols.length} changed symbols · ${r.sectionsReviewed} doc sections touched · ${r.llmChecked} LLM-checked${r.costUsd ? ` ($${r.costUsd.toFixed(2)})` : ''}`);
  if (!r.findings.length) { L.push('', '✅ No drift or gaps detected.'); return L.join('\n'); }
  const groups: Record<string, string> = { inconsistent: '❌ Inconsistent with code', stale_path: '🔗 Stale path references', stale_symbol: '🔍 Stale symbol references', review_section: '👀 Sections to review', undocumented_symbol: '📝 Undocumented changes' };
  for (const [kind, title] of Object.entries(groups)) {
    const fs = r.findings.filter((f) => f.kind === kind); if (!fs.length) continue;
    L.push('', `### ${title} (${fs.length})`);
    const cap = kind === 'undocumented_symbol' ? 15 : 40;
    for (const f of fs.slice(0, cap)) L.push(`- ${f.message}${f.suggestion ? ` _→ ${f.suggestion}_` : ''}`);
    if (fs.length > cap) L.push(`- …and ${fs.length - cap} more`);
  }
  L.push('', '<sub>Generated by Recall — `recall drift`</sub>');
  return L.join('\n');
}
