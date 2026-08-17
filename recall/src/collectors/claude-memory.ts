// Collector for Claude Code auto-memory: ~/.claude/projects/<slug>/memory/*.md (MEMORY.md index + topic files).
// Facts Claude decided to remember are high-signal; we ingest them as subjects/decisions/rules with provenance 'claude-code'
// so they get provenance, decay, verification and team-sync like everything else — and we never write into that dir here.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { DraftEntity } from '../core/schema.js';
import { claudeProjectsDir, slugToPath } from './claude-code.js';

export interface MemoryFile { projectPath: string; path: string; mtimeMs: number; text: string }

export function discoverMemory(): MemoryFile[] {
  const root = claudeProjectsDir(); if (!existsSync(root)) return [];
  const out: MemoryFile[] = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const mdir = join(root, d.name, 'memory'); if (!existsSync(mdir)) continue;
    for (const f of readdirSync(mdir)) {
      if (!f.endsWith('.md')) continue;
      const p = join(mdir, f); let st; try { st = statSync(p); } catch { continue; }
      try { out.push({ projectPath: slugToPath(d.name), path: p, mtimeMs: st.mtimeMs, text: readFileSync(p, 'utf-8') }); } catch { /* skip */ }
    }
  }
  return out;
}

/** Split a memory markdown file into entries (## headings or bullet paragraphs) and classify them. */
export function extractFromMemory(f: MemoryFile, resolvedProject?: string): DraftEntity[] {
  const project = resolvedProject ?? f.projectPath;
  const prov = { source: 'claude-code' as const, docPath: f.path, observedAt: new Date(f.mtimeMs).toISOString(), extractor: 'heuristic' as const };
  const out: DraftEntity[] = [];
  const name = basename(f.path, '.md');
  // frontmatter-style memories (name/description) or headed sections
  const body = f.text.replace(/^---[\s\S]*?---\n/, '');
  const sections = body.split(/\n(?=#{1,3}\s)/).map((s) => s.trim()).filter((s) => s.length > 20);
  const chunks = sections.length ? sections : [body];
  for (const c of chunks.slice(0, 40)) {
    const title = (c.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? name).trim();
    const text = c.replace(/^#{1,3}\s+.+$/m, '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (text.length < 15) continue;
    if (name === 'MEMORY' && /^- \[/.test(c)) continue; // index lines
    const isRule = /\b(always|never|don't|do not|must|prefer|avoid|should)\b/i.test(text) && text.length < 300;
    const isDecision = /\b(decided|chose|because|instead of|rather than|we use|switched to)\b/i.test(text);
    if (isRule) out.push({ type: 'rule', scope: 'project', sensitivity: 'internal', projectPath: project, provenance: [prov], ruleText: text.slice(0, 240), category: 'convention', appliesTo: {}, enforcement: 'inform', confidence: 0.6, paths: [] });
    else if (isDecision) out.push({ type: 'decision', scope: 'project', sensitivity: 'internal', projectPath: project, provenance: [prov], title: title.slice(0, 100), context: '', choice: text.slice(0, 300), alternatives: [], consequences: [], status: 'active', confidence: 0.55, paths: [] });
    else out.push({ type: 'subject', scope: 'project', sensitivity: 'internal', projectPath: project, provenance: [prov], kind: 'subsystem', path: `memory:${name}`, symbol: title.slice(0, 80), summary: text.slice(0, 300), responsibilities: [], constraints: [], interactions: [], confidence: 0.5, paths: [] });
  }
  return out;
}
