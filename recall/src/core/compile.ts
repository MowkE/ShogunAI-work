// Rules compiler: render high-confidence rules/decisions into native rule files for any agent.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Entity } from './schema.js';
import { Store } from './store.js';

const START = '<!-- recall:start -->';
const END = '<!-- recall:end -->';

function replaceBlock(existing: string, block: string): string {
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (re.test(existing)) return existing.replace(re, block);
  return (existing.trimEnd() + (existing.trim() ? '\n\n' : '') + block + '\n');
}

export function selectForCompile(store: Store, projectPath: string, opts: { minConfidence?: number; minEvidence?: number; maxRules?: number } = {}) {
  const minC = opts.minConfidence ?? 0.55, minE = opts.minEvidence ?? 1;
  const rules = store.allEntities({ type: 'rule', projectPath }).filter((e) => e.validity.confidence >= minC && e.validity.evidence >= minE && e.validity.usefulness > -0.5)
    .sort((a, b) => (b.validity.confidence * (1 + Math.log2(1 + b.validity.evidence))) - (a.validity.confidence * (1 + Math.log2(1 + a.validity.evidence)))).slice(0, opts.maxRules ?? 25) as Extract<Entity, { type: 'rule' }>[];
  const decisions = store.allEntities({ type: 'decision', projectPath }).filter((e) => e.validity.confidence >= minC && (e as Extract<Entity, { type: 'decision' }>).status === 'active').slice(0, 12) as Extract<Entity, { type: 'decision' }>[];
  return { rules, decisions };
}

export function renderMarkdown(rules: Extract<Entity, { type: 'rule' }>[], decisions: Extract<Entity, { type: 'decision' }>[], opts: { title?: string; frontmatterPaths?: string[] } = {}): string {
  const L: string[] = [];
  if (opts.frontmatterPaths?.length) { L.push('---', 'paths:', ...opts.frontmatterPaths.map((p) => `  - "${p}"`), '---', ''); }
  L.push(START, `## ${opts.title ?? 'Project knowledge (Recall)'}`, '', 'Distilled from past agent sessions in this repository. Treat rules as requirements unless the user says otherwise; run `recall explain <id>` to see the evidence.', '');
  if (rules.length) {
    L.push('### Rules');
    for (const r of rules) {
      const scope = r.appliesTo.paths?.length ? ` _(applies to: ${r.appliesTo.paths.slice(0, 3).join(', ')})_` : '';
      L.push(`- ${r.ruleText}${scope} \`${r.id.slice(0, 8)}\``);
      if (r.example) L.push(`  - e.g. ~~${r.example.before.slice(0, 80)}~~ → ${r.example.after.slice(0, 80)}`);
    }
    L.push('');
  }
  if (decisions.length) {
    L.push('### Decisions in force');
    for (const d of decisions) L.push(`- **${d.title}** — ${d.choice}${d.alternatives.length ? ` (over: ${d.alternatives.slice(0, 3).join(', ')})` : ''} \`${d.id.slice(0, 8)}\``);
    L.push('');
  }
  L.push(END);
  return L.join('\n');
}

export interface CompileTarget { file: string; frontmatterPaths?: string[] }

/** Write compiled rules into the project's agent rule files. Returns files written. */
export function compileRules(store: Store, projectPath: string, targets?: CompileTarget[]): { written: string[]; rules: number; decisions: number } {
  const { rules, decisions } = selectForCompile(store, projectPath);
  const files = targets ?? [
    { file: join(projectPath, '.claude', 'rules', 'recall.md') },
    { file: join(projectPath, '.cursor', 'rules', 'recall.mdc') },
    { file: join(projectPath, 'AGENTS.md') },
  ];
  const written: string[] = [];
  for (const t of files) {
    if (!rules.length && !decisions.length) continue;
    const isMdc = t.file.endsWith('.mdc');
    let block = renderMarkdown(rules, decisions, { frontmatterPaths: t.frontmatterPaths });
    if (isMdc) block = `---\ndescription: Project knowledge distilled by Recall from past agent sessions\nalwaysApply: true\n---\n` + block;
    // AGENTS.md is shared with humans: only append our block; never create it if it doesn't exist and there is nothing to say
    const existing = existsSync(t.file) ? readFileSync(t.file, 'utf-8') : '';
    if (!existsSync(t.file) && t.file.endsWith('AGENTS.md')) { mkdirSync(dirname(t.file), { recursive: true }); writeFileSync(t.file, `# AGENTS.md\n\n${block}\n`); written.push(t.file); continue; }
    mkdirSync(dirname(t.file), { recursive: true });
    const next = isMdc || t.file.includes('/.claude/rules/') ? (existing.includes(START) ? replaceBlock(existing, block.replace(/^---[\s\S]*?---\n/, '')) : block) : replaceBlock(existing, block);
    writeFileSync(t.file, next);
    written.push(t.file);
  }
  return { written, rules: rules.length, decisions: decisions.length };
}
