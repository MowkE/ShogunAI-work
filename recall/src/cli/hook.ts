#!/usr/bin/env node
// recall-hook <event>: invoked by Claude Code hooks. Reads the hook JSON on stdin, prints a JSON response.
// Events: session-start | prompt | guard | observe | stop | ingest
// Design: never crash the agent. Any failure → exit 0 with no output. Keep it fast (no LLM calls here).

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { Store, defaultDbPath } from '../core/store.js';
import { retrieve, formatContext, type Hit } from '../core/retrieve.js';
import { ingest } from '../extract/ingest.js';
import * as claudeCode from '../collectors/claude-code.js';
import type { Entity } from '../core/schema.js';
import { daemonCall, ensureDaemon } from './daemon.js';

interface RetrieveResp { hits: { id: string; type: string; score: number; caveats: string[]; verified: boolean | null; entity: Entity }[]; context: string; latencyMs: number }

/** Retrieve via the warm daemon (transformer embeddings); fall back to in-process lexical retrieval and kick the daemon. */
async function retrieveSmart(store: Store, q: Parameters<typeof retrieve>[1], surface: string, maxChars?: number): Promise<{ ids: string[]; context: string; via: string }> {
  try {
    const r = await daemonCall<RetrieveResp>('/retrieve', { query: q, surface, maxChars, record: true }, 1500);
    return { ids: r.hits.map((h) => h.id), context: r.context, via: 'daemon' };
  } catch {
    ensureDaemon();
    const hits = retrieve(store, q);
    const context = formatContext(hits, { maxChars });
    if (hits.length) store.recordInjection({ sessionId: q.sessionId, surface, query: q.intent, entityIds: hits.map((h) => h.entity.id), cwd: q.cwd, latencyMs: 0 });
    return { ids: hits.map((h) => h.entity.id), context, via: 'local' };
  }
}

interface HookInput {
  session_id?: string; transcript_path?: string; cwd?: string; hook_event_name?: string; permission_mode?: string;
  prompt?: string; tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string; source?: string; stop_hook_active?: boolean; reason?: string;
}

const LOG = join(homedir(), '.recall', 'hook.log');
function log(msg: string) { try { mkdirSync(join(homedir(), '.recall'), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ } }

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = ''; process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => resolve(s));
    setTimeout(() => resolve(s), 1500);
  });
}

/** Files the agent recently touched, from the transcript tail (cheap: read last ~200KB). */
function recentFiles(transcriptPath?: string, cwd?: string, limit = 12): string[] {
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

function mentionedFiles(text: string): string[] {
  const m = text.match(/[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|md|json|yaml|yml|toml|sql|css|html|sh)\b/g) ?? [];
  return [...new Set(m)].slice(0, 8);
}

function out(obj: unknown) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function main() {
  const event = process.argv[2] ?? '';
  const raw = await readStdin();
  let input: HookInput = {};
  try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  const t0 = Date.now();
  if (!Store.exists(defaultDbPath()) && event !== 'ingest') return; // nothing to inject yet
  const store = new Store();
  try {
    switch (event) {
      case 'session-start': {
        // project brief: top rules + decisions for this cwd (no LLM)
        const cwd = input.cwd; if (!cwd) return;
        const r = await retrieveSmart(store, { intent: 'project conventions rules decisions overview', cwd, sessionId: input.session_id, types: ['rule', 'decision'], topK: { rule: 6, decision: 3 }, projectOnly: true, minConfidence: { rule: 0.5, decision: 0.5 } }, 'hook:session-start', 2200);
        if (!r.ids.length) return;
        const ctx = r.context.replace('<recall-context ', '<recall-context kind="project-brief" ');
        log(`session-start: ${r.ids.length} via ${r.via} in ${Date.now() - t0}ms`);
        out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } });
        break;
      }
      case 'prompt': {
        const prompt = input.prompt ?? ''; const cwd = input.cwd;
        if (prompt.trim().length < 12 || /^(y|yes|n|no|ok|okay|continue|go|proceed|k|thanks)[.!]?$/i.test(prompt.trim())) return;
        const files = [...mentionedFiles(prompt), ...recentFiles(input.transcript_path, cwd)];
        const r = await retrieveSmart(store, { intent: prompt, cwd, files, sessionId: input.session_id }, 'hook:prompt');
        if (!r.ids.length) { log(`prompt: no hits via ${r.via} (${Date.now() - t0}ms)`); return; }
        log(`prompt: ${r.ids.length} hits via ${r.via} in ${Date.now() - t0}ms`);
        out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.context } });
        break;
      }
      case 'guard': {
        // Block/warn on high-confidence rules with enforcement != inform that apply to the touched path.
        const p = input.tool_input?.file_path ?? input.tool_input?.path;
        const cwd = input.cwd ?? '';
        const rel = typeof p === 'string' ? (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) : undefined;
        const cmd = typeof input.tool_input?.command === 'string' ? (input.tool_input!.command as string) : '';
        const rules = store.allEntities({ type: 'rule', projectPath: cwd }) as Extract<Entity, { type: 'rule' }>[];
        const applicable = rules.filter((r) => r.enforcement !== 'inform' && r.validity.confidence >= 0.8 && r.validity.evidence >= 2 && r.validity.usefulness > -0.3
          && ((rel && (r.appliesTo.paths ?? []).some((ap) => rel === ap || rel.startsWith(ap.replace(/\*+$/, '')))) || (cmd && /\b(rm -rf|force|--no-verify|reset --hard)\b/.test(cmd) && r.category === 'safety')));
        if (!applicable.length) return;
        const block = applicable.find((r) => r.enforcement === 'block');
        const reason = applicable.map((r) => `${r.ruleText} [${r.id.slice(0, 8)}]`).join(' | ');
        if (block) {
          out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Recall rule: ${reason}` } });
        } else {
          out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: `<recall-guard>Heads-up from past sessions: ${reason}</recall-guard>` } });
        }
        break;
      }
      case 'observe': {
        // Feedback: if the agent edited a path that a recently injected pointer/subject targets, mark those entities as used.
        const p = input.tool_input?.file_path ?? input.tool_input?.path;
        if (typeof p !== 'string' || !input.session_id) return;
        const cwd = input.cwd ?? ''; const rel = cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
        const recent = store.recentInjectionsForSession(input.session_id, 5);
        const ids = new Set<string>(); for (const r of recent) for (const id of JSON.parse(r.entity_ids) as string[]) ids.add(id);
        for (const id of ids) { const e = store.getEntity(id); if (e && e.paths.includes(rel)) store.recordFeedback(id, 'used', input.session_id); }
        break;
      }
      case 'stop': {
        // lightweight: nothing yet (placeholder for end-of-turn signals). Real-time ingest happens on SessionEnd.
        break;
      }
      case 'ingest': {
        const tp = input.transcript_path;
        if (!tp || !existsSync(tp)) return;
        try { await daemonCall('/ingest', { paths: [tp] }, 1500); log('ingest(session-end): queued on daemon'); return; } catch { ensureDaemon(); }
        const ref = claudeCode.discover().find((r) => r.path === tp);
        if (!ref) return;
        const { hashingEmbedder } = await import('../core/embed.js');
        const r = await ingest(store, { paths: [ref.path], llm: null, force: false, embedder: hashingEmbedder });
        log(`ingest(session-end, local): ${JSON.stringify(r)}`);
        break;
      }
      default: return;
    }
  } catch (e) {
    log(`error in ${event}: ${(e as Error).stack ?? e}`);
  } finally {
    store.close();
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
