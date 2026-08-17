#!/usr/bin/env node
// recall-mcp: stdio MCP server exposing the KB to any MCP client (Claude Code, Cursor, etc.)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from '../core/store.js';
import { retrieveAsync, formatContext } from '../core/retrieve.js';
import { pickEmbedder, hashingEmbedder } from '../core/embed.js';
import { daemonCall } from '../cli/daemon.js';
import { mergeDrafts } from '../core/merge.js';
import type { DraftEntity } from '../core/schema.js';

const server = new McpServer({ name: 'recall', version: '0.1.0' });
const store = new Store();
let embedderPromise: ReturnType<typeof pickEmbedder> | null = null;
const localEmbedder = () => (embedderPromise ??= pickEmbedder());
const ENTITY_TYPES = ['pointer', 'procedure', 'rule', 'decision', 'subject'] as const;

server.registerTool('recall_search', {
  title: 'Search project knowledge',
  description: 'Search the local knowledge base built from past coding-agent sessions. Call this before starting a non-trivial task (debugging, implementing, refactoring) to get pointers to the right files, rules from past corrections, procedures that worked, and decisions in force. Phrase the query as subject + outcome (e.g. "auth middleware — why valid sessions get rejected"). Pass the files you are working on to boost related knowledge.',
  inputSchema: {
    query: z.string().describe('What you are trying to do or understand'),
    files: z.array(z.string()).optional().describe('Repo-relative paths you are working on'),
    cwd: z.string().optional().describe('Project root (defaults to the server process cwd)'),
    types: z.array(z.enum(ENTITY_TYPES)).optional().describe('Restrict to entity types'),
  },
}, async ({ query, files, cwd, types }) => {
  const t0 = Date.now();
  const q = { intent: query, cwd: cwd ?? process.cwd(), files, types };
  // Prefer the warm daemon (transformer embeddings, shared store); fall back to in-process retrieval.
  try {
    const r = await daemonCall<{ context: string; hits: unknown[] }>('/retrieve', { query: q, surface: 'mcp', maxChars: 6000 }, 3000);
    return { content: [{ type: 'text', text: r.hits.length ? r.context : 'No relevant knowledge found for this query. Try rephrasing with the component name plus the outcome you need, or narrow the scope.' }] };
  } catch { /* daemon down */ }
  const hits = await retrieveAsync(store, q, localEmbedder());
  store.recordInjection({ surface: 'mcp', query, entityIds: hits.map((h) => h.entity.id), cwd: cwd ?? process.cwd(), latencyMs: Date.now() - t0 });
  const text = hits.length ? formatContext(hits, { maxChars: 6000 }) : 'No relevant knowledge found for this query. Try rephrasing with the component name plus the outcome you need, or narrow the scope.';
  return { content: [{ type: 'text', text }] };
});

server.registerTool('recall_explain', {
  title: 'Explain a knowledge entry',
  description: 'Show the full entity behind an id from recall_search (accepts an id prefix), including provenance (which sessions/messages it came from), confidence, evidence count and verification target.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  const e = store.allEntities().find((x) => x.id.startsWith(id));
  if (!e) return { content: [{ type: 'text', text: `No entity with id ${id}` }], isError: true };
  return { content: [{ type: 'text', text: JSON.stringify({ ...e, embedding: undefined }, null, 2) }] };
});

server.registerTool('recall_remember', {
  title: 'Remember a fact or rule',
  description: 'Store a durable fact for future sessions: a rule (something the user asked you to always/never do), a decision (a choice made and why), or a pointer (where to look for a class of task). Use sparingly for things that will matter again.',
  inputSchema: {
    kind: z.enum(['rule', 'decision', 'pointer']),
    text: z.string().describe('For rule: the imperative rule. For decision: "title — choice — because". For pointer: "task class — path: reason; path: reason"'),
    paths: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  },
}, async ({ kind, text, paths, cwd }) => {
  const project = cwd ?? process.cwd();
  const prov = { source: 'agent' as const, observedAt: new Date().toISOString(), extractor: 'llm' as const };
  let draft: DraftEntity;
  if (kind === 'rule') draft = { type: 'rule', scope: 'project', sensitivity: 'internal', projectPath: project, provenance: [prov], ruleText: text, category: 'convention', appliesTo: { paths }, enforcement: 'inform', confidence: 0.7, paths: paths ?? [] };
  else if (kind === 'decision') { const [title, choice, ...rest] = text.split(' — '); draft = { type: 'decision', scope: 'project', sensitivity: 'internal', projectPath: project, provenance: [prov], title: title ?? text, context: rest.join(' — '), choice: choice ?? '', alternatives: [], consequences: [], status: 'active', confidence: 0.7, paths: paths ?? [] }; }
  else { const [outcome, ...targets] = text.split(' — '); const ts = targets.join(' — ').split(';').map((s) => s.trim()).filter(Boolean).map((s, i) => { const [p, ...r] = s.split(':'); return { path: p.trim(), reason: r.join(':').trim() || 'relevant', priority: 5 - i }; });
    draft = { type: 'pointer', scope: 'project', sensitivity: 'internal', projectPath: project, provenance: [prov], outcomeClass: outcome, signals: [], targets: ts, decoys: [], confidence: 0.65, paths: ts.map((t) => t.path) }; }
  const r = await mergeDrafts(store, [draft], localEmbedder());
  return { content: [{ type: 'text', text: `Remembered (${r.inserted ? 'new' : 'merged'}) → id ${r.ids[0]}` }] };
});

server.registerTool('recall_feedback', {
  title: 'Give feedback on injected knowledge',
  description: 'Tell Recall whether an entry from recall_search or <recall-context> was useful, not useful, or wrong. This trains ranking and decays bad entries.',
  inputSchema: { id: z.string(), signal: z.enum(['useful', 'not_useful', 'wrong']), note: z.string().optional() },
}, async ({ id, signal, note }) => {
  const e = store.allEntities().find((x) => x.id.startsWith(id));
  if (!e) return { content: [{ type: 'text', text: `No entity with id ${id}` }], isError: true };
  store.recordFeedback(e.id, signal, undefined, note);
  return { content: [{ type: 'text', text: `Recorded ${signal} for ${e.id}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
