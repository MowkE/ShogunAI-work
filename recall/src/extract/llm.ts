// LLM extractor: one structured-output call per segment. Output mirrors the entity schema.

import type { DraftEntity, Segment, Provenance } from '../core/schema.js';
import { renderSegment } from './segment.js';
import type { JsonModel } from './model.js';

export const EXTRACTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['subjects', 'pointers', 'procedures', 'rules', 'decisions', 'outcome'],
  properties: {
    outcome: { type: 'string', enum: ['accepted', 'abandoned', 'partial', 'unknown'] },
    subjects: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'kind', 'summary', 'responsibilities', 'constraints', 'interactions', 'evidence'], properties: {
      path: { type: 'string' }, symbol: { type: 'string' },
      kind: { type: 'string', enum: ['subsystem', 'module', 'symbol', 'config', 'external', 'tool'] },
      summary: { type: 'string' }, responsibilities: { type: 'array', items: { type: 'string' } },
      constraints: { type: 'array', items: { type: 'string' } },
      interactions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'text'], properties: { path: { type: 'string' }, text: { type: 'string' } } } },
      evidence: { type: 'array', items: { type: 'string' }, description: 'message ids that support this' } } } },
    pointers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['outcomeClass', 'signals', 'targets', 'decoys', 'evidence'], properties: {
      outcomeClass: { type: 'string', description: 'short generic name for the kind of task/bug, e.g. "auth middleware rejects valid session"' },
      signals: { type: 'array', items: { type: 'string' } }, rootCause: { type: 'string' }, resolution: { type: 'string' },
      targets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'reason', 'priority'], properties: { path: { type: 'string' }, symbol: { type: 'string' }, reason: { type: 'string' }, priority: { type: 'integer' } } } },
      decoys: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'condition', 'reason', 'caveat'], properties: { path: { type: 'string' }, condition: { type: 'string' }, reason: { type: 'string' }, caveat: { type: 'string' } } } },
      evidence: { type: 'array', items: { type: 'string' } } } } },
    procedures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['goal', 'steps', 'antiPatterns', 'preconditions', 'evidence'], properties: {
      goal: { type: 'string' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['do'], properties: { do: { type: 'string' }, rationale: { type: 'string' }, command: { type: 'string' } } } },
      antiPatterns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['desc', 'reason'], properties: { desc: { type: 'string' }, reason: { type: 'string' } } } },
      preconditions: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } } } } },
    rules: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ruleText', 'category', 'scope', 'evidence'], properties: {
      ruleText: { type: 'string', description: 'imperative, generalized from the correction; keep it short' },
      category: { type: 'string', enum: ['wrong_pattern', 'wrong_tool', 'wrong_file', 'convention', 'unnecessary_work', 'missing_context', 'safety'] },
      scope: { type: 'string', enum: ['file', 'project', 'global'] },
      paths: { type: 'array', items: { type: 'string' } },
      example: { type: 'object', additionalProperties: false, required: ['before', 'after'], properties: { before: { type: 'string' }, after: { type: 'string' } } },
      evidence: { type: 'array', items: { type: 'string' } } } } },
    decisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'context', 'choice', 'alternatives', 'consequences', 'evidence'], properties: {
      title: { type: 'string' }, context: { type: 'string' }, choice: { type: 'string' },
      alternatives: { type: 'array', items: { type: 'string' } }, consequences: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } } } } },
  },
} as const;

export const SYSTEM_PROMPT = `You extract durable, reusable engineering knowledge from a coding-agent session transcript so that a future agent working in the same repository can skip re-exploration and avoid repeating mistakes.

Extract only what the transcript evidences. Prefer fewer, higher-confidence entities. Cite the message ids (the bracketed ids in the transcript) that support each entity in its "evidence" array.

Entity guidance:
- subjects: components/modules/config/tools that the session revealed something durable about (what it is, responsibilities, constraints, what it interacts with). Skip trivial or generic files.
- pointers: for a class of task or bug, WHERE to look (targets, ranked) and where NOT to look (decoys, with the condition under which they might matter). Include rootCause/resolution when a bug was fixed.
- procedures: an ordered sequence that achieved a goal (commands, steps), with anti-patterns that failed along the way. Only when the outcome was accepted or clearly worked.
- rules: produce a rule ONLY when the user corrected the agent, expressed a preference, or an approach demonstrably failed and the lesson generalizes. Phrase imperatively; choose the narrowest scope that explains it (file → project → global); include the concrete before/after example when possible.
- decisions: a choice between alternatives with reasoning ("we chose X over Y because…"). Include consequences.
- outcome: whether the user's task in this segment was accepted, abandoned, partial, or unknown.

Never include secrets, credentials, or personal data. Placeholders like <SECRET:...> already replaced them; do not try to reconstruct them. Use repository-relative paths.`;

function prov(seg: Segment, model: string, ids: string[]): Provenance {
  return { source: (['claude-code', 'codex', 'cursor', 'gemini', 'aider', 'opencode'].includes(seg.agent) ? seg.agent : 'agent') as Provenance['source'], sessionId: seg.sessionId, segmentId: seg.id, messageIds: ids.slice(0, 8), observedAt: seg.startedAt, extractor: 'llm', author: model } as Provenance;
}

export function buildExtractionRequest(seg: Segment) {
  return { system: SYSTEM_PROMPT, user: renderSegment(seg), schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown> };
}

export async function llmExtract(seg: Segment, model: JsonModel): Promise<{ drafts: DraftEntity[]; costUsd: number; outcome: Segment['outcome'] }> {
  const { data, costUsd, model: modelName } = await model.json(buildExtractionRequest(seg));
  const { drafts, outcome } = mapExtraction(seg, data, modelName);
  return { drafts, costUsd, outcome };
}

/** Map a model's structured output onto entity drafts (shared by live and batch paths). */
export function mapExtraction(seg: Segment, data: unknown, modelName: string): { drafts: DraftEntity[]; outcome: Segment['outcome'] } {
  const d = (data ?? {}) as Record<string, unknown>;
  const drafts: DraftEntity[] = [];
  const P = seg.projectPath;
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

  for (const s of arr<Record<string, never>>(d.subjects)) {
    if (!s.path) continue;
    drafts.push({ type: 'subject', scope: 'project', sensitivity: 'internal', projectPath: P, provenance: [prov(seg, modelName, arr<string>(s.evidence))],
      kind: s.kind ?? 'module', path: s.path, symbol: s.symbol, summary: s.summary ?? '', responsibilities: arr<string>(s.responsibilities), constraints: arr<string>(s.constraints),
      interactions: arr<{ path: string; text: string }>(s.interactions), confidence: 0.6, paths: [s.path as string, ...arr<{ path: string }>(s.interactions).map((i) => i.path)] });
  }
  for (const p of arr<Record<string, never>>(d.pointers)) {
    const targets = arr<{ path: string; symbol?: string; reason: string; priority: number }>(p.targets);
    if (!targets.length) continue;
    const decoys = arr<{ path: string; condition: string; reason: string; caveat: string }>(p.decoys);
    drafts.push({ type: 'pointer', scope: 'project', sensitivity: 'internal', projectPath: P, provenance: [prov(seg, modelName, arr<string>(p.evidence))],
      outcomeClass: p.outcomeClass ?? seg.userPrompt.slice(0, 120), signals: arr<string>(p.signals), rootCause: p.rootCause, resolution: p.resolution,
      targets, decoys, confidence: 0.65, paths: [...targets.map((t) => t.path), ...decoys.map((x) => x.path)] });
  }
  for (const pr of arr<Record<string, never>>(d.procedures)) {
    const steps = arr<{ do: string; rationale?: string; command?: string }>(pr.steps);
    if (!steps.length) continue;
    drafts.push({ type: 'procedure', scope: 'project', sensitivity: 'internal', projectPath: P, provenance: [prov(seg, modelName, arr<string>(pr.evidence))],
      goal: pr.goal ?? '', steps, antiPatterns: arr<{ desc: string; reason: string }>(pr.antiPatterns), preconditions: arr<string>(pr.preconditions), coSubjects: [], confidence: 0.6, paths: seg.filesMutated.slice(0, 6) });
  }
  for (const r of arr<Record<string, never>>(d.rules)) {
    if (!r.ruleText) continue;
    const scope = r.scope === 'global' ? 'personal' : 'project';
    drafts.push({ type: 'rule', scope, sensitivity: 'internal', projectPath: r.scope === 'global' ? '' : P, provenance: [prov(seg, modelName, arr<string>(r.evidence))],
      ruleText: r.ruleText, category: r.category ?? 'convention', appliesTo: { paths: arr<string>(r.paths) }, enforcement: r.category === 'safety' ? 'warn' : 'inform',
      example: r.example, confidence: 0.65, paths: arr<string>(r.paths) });
  }
  for (const dc of arr<Record<string, never>>(d.decisions)) {
    if (!dc.title || !dc.choice) continue;
    drafts.push({ type: 'decision', scope: 'project', sensitivity: 'internal', projectPath: P, provenance: [prov(seg, modelName, arr<string>(dc.evidence))],
      title: dc.title, context: dc.context ?? '', choice: dc.choice, alternatives: arr<string>(dc.alternatives), consequences: arr<string>(dc.consequences), status: 'active', confidence: 0.6, paths: seg.filesMutated.slice(0, 6) });
  }
  const outcome = (['accepted', 'abandoned', 'partial', 'unknown'] as const).includes(d.outcome as never) ? (d.outcome as Segment['outcome']) : seg.outcome;
  return { drafts, outcome };
}
