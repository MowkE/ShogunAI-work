// Shared hook logic: used by the daemon (/hook, transformer embeddings, warm store) and by the Node fallback (hashing).
import { readFileSync, existsSync } from 'node:fs';
import { Store } from '../core/store.js';
import { retrieveAsync, formatContext, type Query } from '../core/retrieve.js';
import { hashingEmbedder, type Embedder } from '../core/embed.js';
import { compileRules } from '../core/compile.js';
import type { Entity } from '../core/schema.js';

export interface HookInput {
  session_id?: string; transcript_path?: string; cwd?: string; hook_event_name?: string; permission_mode?: string;
  prompt?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string; source?: string; stop_hook_active?: boolean; reason?: string;
}
export type HookOutput = Record<string, unknown> | null;

/** Files the agent recently touched, from the transcript tail (cheap: read last ~200KB). */
export function recentFiles(transcriptPath?: string, cwd?: string, limit = 12): string[] {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  try {
    const buf = readFileSync(transcriptPath);
    const tail = buf.subarray(Math.max(0, buf.length - 200_000)).toString('utf-8');
    const out: string[] = [];
    for (const line of tail.split('\n').reverse()) {
      if (out.length >= limit) break;
      if (!line.includes('"tool_use"')) continue;
      try {
        const o = JSON.parse(line) as { message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } };
        for (const b of o.message?.content ?? []) {
          if (b.type !== 'tool_use') continue;
          const p = b.input?.file_path ?? b.input?.path;
          if (typeof p === 'string') { const rel = cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p; if (!out.includes(rel)) out.push(rel); }
        }
      } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

export function mentionedFiles(text: string): string[] {
  const m = text.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|md|json|yaml|yml|toml|sql|css|html|sh|swift|kt)\b/g) ?? [];
  return [...new Set(m)].slice(0, 8);
}

const TRIVIAL = /^(y|yes|n|no|ok|okay|continue|go|proceed|k|thanks)[.!]?$/i;

/** Handle one hook event. Pure w.r.t. process: no stdin/stdout/exit. */
export async function handleHook(store: Store, embedder: Embedder, event: string, input: HookInput, opts: { surfacePrefix?: string; onIngest?: (paths: string[]) => void } = {}): Promise<HookOutput> {
  const t0 = Date.now();
  const surface = (s: string) => `${opts.surfacePrefix ?? 'hook'}:${s}`;
  const run = async (q: Query, sfc: string, maxChars?: number) => {
    const hits = await retrieveAsync(store, q, embedder);
    const context = formatContext(hits, { maxChars });
    if (hits.length) store.recordInjection({ sessionId: q.sessionId, surface: sfc, query: q.intent, entityIds: hits.map((h) => h.entity.id), cwd: q.cwd, latencyMs: Date.now() - t0 });
    return { hits, context };
  };
  switch (event) {
    case 'session-start': {
      const cwd = input.cwd; if (!cwd) return null;
      const r = await run({ intent: 'project conventions rules decisions overview', cwd, sessionId: input.session_id, types: ['rule', 'decision'], topK: { rule: 6, decision: 3 }, projectOnly: true, minConfidence: { rule: 0.5, decision: 0.5 } }, surface('session-start'), 2200);
      if (!r.hits.length) return null;
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.context.replace('<recall-context ', '<recall-context kind="project-brief" ') } };
    }
    case 'prompt': {
      const prompt = input.prompt ?? ''; const cwd = input.cwd;
      if (prompt.trim().length < 12 || TRIVIAL.test(prompt.trim())) return null;
      const files = [...mentionedFiles(prompt), ...recentFiles(input.transcript_path, cwd)];
      const r = await run({ intent: prompt, cwd, files, sessionId: input.session_id }, surface('prompt'));
      if (!r.hits.length) return null;
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.context } };
    }
    case 'guard': {
      const p = input.tool_input?.file_path ?? input.tool_input?.path;
      const cwd = input.cwd ?? '';
      const rel = typeof p === 'string' ? (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) : undefined;
      const cmd = typeof input.tool_input?.command === 'string' ? (input.tool_input!.command as string) : '';
      const rules = store.allEntities({ type: 'rule', projectPath: cwd }) as Extract<Entity, { type: 'rule' }>[];
      const applicable = rules.filter((r) => r.enforcement !== 'inform' && r.validity.confidence >= 0.8 && r.validity.evidence >= 2 && r.validity.usefulness > -0.3
        && ((rel && (r.appliesTo.paths ?? []).some((ap) => rel === ap || rel.startsWith(ap.replace(/\*+$/, '')))) || (cmd && /\b(rm -rf|force|--no-verify|reset --hard)\b/.test(cmd) && r.category === 'safety')));
      if (!applicable.length) return null;
      const block = applicable.find((r) => r.enforcement === 'block');
      const reason = applicable.map((r) => `${r.ruleText} [${r.id.slice(0, 8)}]`).join(' | ');
      return block
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Recall rule: ${reason}` } }
        : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: `<recall-guard>Heads-up from past sessions: ${reason}</recall-guard>` } };
    }
    case 'observe': {
      const p = input.tool_input?.file_path ?? input.tool_input?.path;
      if (typeof p !== 'string' || !input.session_id) return null;
      const cwd = input.cwd ?? ''; const rel = cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
      const recent = store.recentInjectionsForSession(input.session_id, 5);
      const ids = new Set<string>(); for (const r of recent) for (const id of JSON.parse(r.entity_ids) as string[]) ids.add(id);
      for (const id of ids) { const e = store.getEntity(id); if (e && e.paths.includes(rel)) store.recordFeedback(id, 'used', input.session_id); }
      return null;
    }
    case 'ingest': {
      const tp = input.transcript_path;
      if (tp && existsSync(tp)) opts.onIngest?.([tp]);
      // keep compiled rules fresh for this project (cheap; only rewrites when content changed)
      if (input.cwd) { try { compileRules(store, input.cwd); } catch { /* ignore */ } }
      return null;
    }
    default: return null;
  }
}

export { hashingEmbedder };
