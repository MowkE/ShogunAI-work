// Heuristic (no-LLM) extractor: cheap, always-on. Produces conservative drafts from tool activity
// and detected corrections. The LLM extractor refines and adds decisions/procedures.

import type { DraftEntity, Segment, Provenance } from '../core/schema.js';
import { basename } from 'node:path';

const IGNORE_PATH = /(^|\/)(node_modules|dist|build|\.git|\.next|coverage)(\/|$)|\/\.claude\/projects\/|^\/(private\/)?tmp\/|^\/var\/folders\/|\.(lock|png|jpg|jpeg|gif|svg|ico|pdf|zip|tgz|gz)$/i;

function prov(seg: Segment, extra: Partial<Provenance> = {}): Provenance {
  return { source: seg.agent === 'claude-code' ? 'claude-code' : 'agent', sessionId: seg.sessionId, segmentId: seg.id, observedAt: seg.startedAt, extractor: 'heuristic', ...extra } as Provenance;
}

export function heuristicExtract(seg: Segment): DraftEntity[] {
  const out: DraftEntity[] = [];
  const mutated = seg.filesMutated.filter((p) => !IGNORE_PATH.test(p));
  const read = seg.filesRead.filter((p) => !IGNORE_PATH.test(p) && !mutated.includes(p));
  const promptShort = seg.userPrompt.replace(/\s+/g, ' ').slice(0, 160);

  // Pointer: "for a task like this, these files were where the work happened; these were read but not touched"
  if (mutated.length && seg.outcome !== 'abandoned') {
    out.push({
      type: 'pointer', scope: 'project', sensitivity: 'internal', projectPath: seg.projectPath,
      provenance: [prov(seg)],
      outcomeClass: promptShort,
      signals: [],
      resolution: undefined,
      targets: mutated.slice(0, 8).map((p, i) => ({ path: p, reason: 'edited while completing this task', priority: 8 - i })),
      decoys: read.slice(0, 4).map((p) => ({ path: p, condition: 'unless the task explicitly concerns it', reason: 'read but not edited for a similar task', caveat: 'heuristic — verify' })),
      confidence: seg.outcome === 'accepted' ? 0.55 : 0.4,
      paths: [...mutated, ...read.slice(0, 4)],
    });
  }

  // Subjects: each mutated file becomes a light subject (path + name only; LLM fills summary)
  for (const p of mutated.slice(0, 6)) {
    out.push({
      type: 'subject', scope: 'project', sensitivity: 'internal', projectPath: seg.projectPath,
      provenance: [prov(seg)], kind: 'module', path: p, summary: `${basename(p)} — edited while: ${promptShort.slice(0, 100)}`,
      responsibilities: [], constraints: [], interactions: mutated.filter((q) => q !== p).slice(0, 5).map((q) => ({ path: q, text: 'changed together' })),
      confidence: 0.35, paths: [p],
    });
  }

  // Rules from corrections (kept close to the user's own words; LLM pass generalizes)
  for (const c of seg.corrections) {
    const text = c.text.replace(/\s+/g, ' ').trim();
    if (text.length < 8) continue;
    out.push({
      type: 'rule', scope: 'project', sensitivity: 'internal', projectPath: seg.projectPath,
      provenance: [prov(seg, { messageIds: [c.afterEventId] })],
      ruleText: text.length > 240 ? text.slice(0, 240) + '…' : text,
      category: /file|path|dir/i.test(text) ? 'wrong_file' : /tool|command|use /i.test(text) ? 'wrong_tool' : /don't|do not|never|stop/i.test(text) ? 'unnecessary_work' : 'convention',
      appliesTo: { paths: mutated.slice(0, 5) },
      enforcement: 'inform',
      confidence: 0.4,
      paths: mutated.slice(0, 5),
    });
  }

  // Procedure from a successful command sequence (tests/build/deploy-ish)
  const cmds = seg.commands.filter((c) => /\b(npm|pnpm|yarn|bun|pytest|cargo|go |make|docker|git|prisma|alembic|tsc|vitest|jest)\b/.test(c));
  if (seg.outcome === 'accepted' && cmds.length >= 2) {
    out.push({
      type: 'procedure', scope: 'project', sensitivity: 'internal', projectPath: seg.projectPath,
      provenance: [prov(seg)], goal: promptShort,
      steps: cmds.slice(0, 8).map((c) => ({ do: `run: ${c}`, command: c })),
      antiPatterns: [], preconditions: [], coSubjects: mutated.slice(0, 5),
      confidence: 0.35, paths: mutated.slice(0, 5),
    });
  }
  return out;
}
