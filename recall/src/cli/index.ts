#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { Store, defaultDbPath } from '../core/store.js';
import { retrieve, formatContext } from '../core/retrieve.js';
import { compileRules } from '../core/compile.js';
import { ingest, ingestRepo } from '../extract/ingest.js';
import { pickModel, hasAnthropicCreds } from '../extract/model.js';
import * as claudeCode from '../collectors/claude-code.js';
import { discoverAll } from '../collectors/index.js';
import { segmentsOf } from '../extract/ingest.js';
import { renderSegment } from '../extract/segment.js';
import { daemonCall, daemonRunning, ensureDaemon, DAEMON_PORT } from './daemon.js';
import { pickEmbedder } from '../core/embed.js';
import { reindex } from '../core/merge.js';
import { retrieveAsync } from '../core/retrieve.js';

const here = dirname(fileURLToPath(import.meta.url));
const distRoot = resolve(here, '..');
const NODE_HOOK = join(distRoot, 'cli', 'hook.js');
const SHIM = resolve(distRoot, '..', 'hookbin', 'recall-hook');
// Prefer the compiled bun shim (≈40 ms end-to-end via the daemon); it execs the Node hook when the daemon is down.
const HOOK_BIN = process.env.RECALL_HOOK_BIN ?? (existsSync(SHIM) ? `RECALL_HOOK_FALLBACK=${JSON.stringify(NODE_HOOK)} ${JSON.stringify(SHIM)}` : `node --no-warnings ${JSON.stringify(NODE_HOOK)}`);
const MCP_BIN_ARGS = ['--no-warnings', join(distRoot, 'mcp', 'server.js')];

const program = new Command();
program.name('recall').description('Local-first knowledge layer for coding agents').version('0.1.0');

program.command('init')
  .description('Build the KB from your transcripts and install hooks + MCP (project scope by default)')
  .option('--user', 'install hooks/MCP at user scope (~/.claude/settings.json) instead of the project')
  .option('--project <path>', 'project root to install into', process.cwd())
  .option('--since <days>', 'ingest transcripts from the last N days', '90')
  .option('--no-llm', 'skip LLM refinement (heuristic extraction only)')
  .option('--llm-segments <n>', 'max segments to refine with the LLM in this run', '15')
  .option('--max-cost <usd>', 'stop LLM refinement after this spend', '5')
  .action(async (o) => {
    const store = new Store();
    const model = o.llm ? await pickModel() : null;
    console.error(`recall init · db ${store.path} · model ${model?.name ?? 'none (heuristic only)'}`);
    const r = await ingest(store, { since: Number(o.since), llm: model, maxLlmSegments: Number(o.llmSegments), maxCostUsd: Number(o.maxCost), onProgress: (m) => console.error('  ' + m) });
    console.error(`\ningested ${r.sessions} sessions → ${r.segments} segments (${r.llmSegments} LLM-refined, $${r.costUsd.toFixed(2)}) · ${r.inserted} new / ${r.merged} merged entities · ${r.redactions} secrets redacted`);
    const proj = resolve(o.project);
    installHooks(proj, !!o.user);
    installMcp(proj, !!o.user);
    const c = compileRules(store, proj);
    console.error(`compiled ${c.rules} rules / ${c.decisions} decisions → ${c.written.map((f) => f.replace(proj + '/', '')).join(', ') || '(nothing to write yet)'}`);
    store.close();
    ensureDaemon(); console.error('daemon started (warm embeddings, transcript watcher)');
    console.error(`\nDone. Start a new Claude Code session in ${proj} — context is injected automatically. Try: recall search "how does X work"`);
  });

program.command('ingest')
  .description('Ingest transcripts into the KB (incremental)')
  .option('--since <days>', 'only transcripts from the last N days')
  .option('--project <substr>', 'filter by project path substring')
  .option('--session <id>', 'single session id prefix')
  .option('--max <n>', 'max sessions')
  .option('--llm', 'refine with the LLM (claude -p or Anthropic SDK)')
  .option('--llm-segments <n>', 'max LLM segments this run', '25')
  .option('--max-cost <usd>', 'LLM spend cap', '5')
  .option('--force', 're-process even if already ingested')
  .option('--collectors <ids...>', 'restrict to collectors: claude-code codex cursor')
  .action(async (o) => {
    const store = new Store();
    const model = o.llm ? await pickModel() : null;
    console.error(`model: ${model?.name ?? 'none'}${model && !hasAnthropicCreds() ? ' (claude -p; each call carries Claude Code overhead ~$0.10)' : ''}`);
    const r = await ingest(store, { since: o.since ? Number(o.since) : undefined, project: o.project, session: o.session, max: o.max ? Number(o.max) : undefined, llm: model, maxLlmSegments: Number(o.llmSegments), maxCostUsd: Number(o.maxCost), force: !!o.force, collectors: o.collectors, onProgress: (m) => console.error('  ' + m) });
    console.log(JSON.stringify(r, null, 2));
    store.close();
  });

program.command('ingest-repo [repos...]')
  .description('Ingest git history (+ GitHub PR review comments via gh) for repos; default: every git repo seen in your sessions')
  .option('--max-commits <n>', 'commits per repo', '400')
  .option('--max-prs <n>', 'PRs per repo', '40')
  .option('--no-prs', 'skip GitHub PRs')
  .option('--force', 're-process')
  .action(async (repos: string[], o) => {
    const store = new Store();
    if (!repos.length) {
      const rows = store.db.prepare('SELECT DISTINCT project_path FROM segments').all() as { project_path: string }[];
      repos = rows.map((r) => r.project_path).filter((p) => existsSync(join(p, '.git')));
    }
    const embedder = pickEmbedder();
    const out = [];
    for (const r of repos) { const res = await ingestRepo(store, resolve(r), { maxCommits: Number(o.maxCommits), maxPrs: Number(o.maxPrs), prs: o.prs, force: !!o.force, embedder, onProgress: (m) => console.error(`  ${r.split('/').pop()}: ${m}`) }); out.push(res); }
    console.log(JSON.stringify(out, null, 2)); store.close();
  });

program.command('search <query...>')
  .description('Query the KB as an agent would')
  .option('-f, --files <paths...>', 'files being worked on (boosts related entities)')
  .option('--cwd <path>', 'project root', process.cwd())
  .option('--json', 'raw JSON output')
  .action(async (q: string[], o) => {
    const store = new Store();
    const t0 = Date.now();
    const query = { intent: q.join(' '), cwd: resolve(o.cwd), files: o.files };
    let hits;
    try {
      const r = await daemonCall<{ hits: { entity: never; score: number; caveats: string[]; verified: boolean | null }[] }>('/retrieve', { query, surface: 'cli', record: false }, 3000);
      hits = r.hits.map((h) => ({ entity: h.entity, score: h.score, caveats: h.caveats, verified: h.verified }));
      console.error('(via daemon)');
    } catch { hits = await retrieveAsync(store, query, pickEmbedder()); }
    if (o.json) console.log(JSON.stringify(hits.map((h) => ({ id: h.entity.id, type: h.entity.type, score: +h.score.toFixed(3), verified: h.verified, caveats: h.caveats, entity: h.entity })), null, 2));
    else { console.log(formatContext(hits, { maxChars: 6000 }) || '(no relevant knowledge yet)'); console.error(`\n${hits.length} hits in ${Date.now() - t0}ms`); }
    store.recordInjection({ surface: 'cli', query: q.join(' '), entityIds: hits.map((h) => h.entity.id), cwd: resolve(o.cwd), latencyMs: Date.now() - t0 });
    store.close();
  });

program.command('explain <id>')
  .description('Show an entity with its provenance (accepts id prefix)')
  .action((id: string) => {
    const store = new Store();
    const all = store.allEntities().filter((e) => e.id.startsWith(id));
    if (!all.length) { console.error('no entity with that id'); process.exit(1); }
    for (const e of all) console.log(JSON.stringify({ ...e, embedding: undefined }, null, 2));
    store.close();
  });

program.command('feedback <id> <signal>')
  .description('Record feedback for an entity: useful | not_useful | wrong')
  .option('--note <text>')
  .action((id: string, signal: string, o) => {
    const store = new Store();
    const e = store.allEntities().find((x) => x.id.startsWith(id));
    if (!e) { console.error('no entity with that id'); process.exit(1); }
    store.recordFeedback(e.id, signal, undefined, o.note);
    console.log(`recorded ${signal} for ${e.id}`); store.close();
  });

program.command('why')
  .description('Show the last injection and its entities')
  .action(() => {
    const store = new Store();
    const last = store.lastInjection();
    if (!last) { console.log('no injections yet'); return; }
    console.log(`${last.created_at} · ${last.surface} · query: ${last.query}`);
    for (const id of JSON.parse(last.entity_ids) as string[]) { const e = store.getEntity(id); if (e) console.log(`- [${e.id.slice(0, 8)}] ${e.type}: ${e.text.slice(0, 140)}`); }
    store.close();
  });

program.command('stats').description('KB statistics').action(() => {
  const store = new Store();
  const s = store.segmentStats(); const i = store.injectionStats();
  console.log(JSON.stringify({ db: store.path, entities: store.countByType(), sessions: s.sessions, segments: s.n, llmSegments: s.llm, llmCostUsd: +s.cost.toFixed(3), injections: i.injections, feedback: i.feedback, usedSignals: i.used }, null, 2));
  store.close();
});

program.command('compile')
  .description('Write compiled rules into .claude/rules, .cursor/rules and AGENTS.md')
  .option('--project <path>', 'project root', process.cwd())
  .action((o) => { const store = new Store(); const c = compileRules(store, resolve(o.project)); console.log(JSON.stringify(c, null, 2)); store.close(); });

program.command('install')
  .description('Install hooks + MCP registration without ingesting')
  .option('--user', 'user scope').option('--project <path>', 'project root', process.cwd())
  .action((o) => { installHooks(resolve(o.project), !!o.user); installMcp(resolve(o.project), !!o.user); });

program.command('uninstall')
  .description('Remove recall hooks + MCP registration')
  .option('--user', 'user scope').option('--project <path>', 'project root', process.cwd())
  .action((o) => { uninstallHooks(resolve(o.project), !!o.user); console.error('removed recall hooks (MCP: run `claude mcp remove recall` if registered at user scope)'); });

program.command('inspect <session>')
  .description('Debug: show segments recall sees in a transcript (id prefix)')
  .option('--render', 'print the redacted rendering sent to the LLM')
  .action((session: string, o) => {
    const ref = discoverAll().find((r) => r.sessionId.startsWith(session));
    if (!ref) { console.error('no such session'); process.exit(1); }
    for (const s of segmentsOf(ref)) {
      console.log(`\n── ${s.id} · ${s.startedAt} · ${s.outcome} · ${s.events.length} events · edits ${s.filesMutated.length} · corrections ${s.corrections.length}\n   ${s.userPrompt.slice(0, 160).replace(/\n/g, ' ')}`);
      if (o.render) console.log(renderSegment(s, 4000));
    }
  });

program.command('doctor').description('Check environment').action(() => {
  const refs = discoverAll();
  const byCollector: Record<string, number> = {}; for (const r of refs) byCollector[r.collector] = (byCollector[r.collector] ?? 0) + 1;
  console.log(JSON.stringify({ node: process.version, db: defaultDbPath(), dbExists: Store.exists(), transcripts: refs.length, byCollector, projects: new Set(refs.map((r) => r.projectPath).filter(Boolean)).size,
    anthropicCreds: hasAnthropicCreds(), claudeCli: which('claude'), modelAdapter: process.env.RECALL_MODEL_ADAPTER ?? 'auto', hookBin: HOOK_BIN }, null, 2));
});

program.command('daemon [action]')
  .description('Manage the warm daemon (start|stop|status|run). Hooks use it for transformer embeddings and sub-100ms retrieval.')
  .action(async (action = 'status') => {
    if (action === 'run') { const { fileURLToPath } = await import('node:url'); execFileSync(process.execPath, ['--no-warnings', fileURLToPath(new URL('./daemon.js', import.meta.url))], { stdio: 'inherit' }); return; }
    if (action === 'start') { if (daemonRunning()) { console.log('already running (pid ' + daemonRunning() + ')'); return; } ensureDaemon(); await new Promise((r) => setTimeout(r, 1500)); console.log(daemonRunning() ? `started (pid ${daemonRunning()}) on 127.0.0.1:${DAEMON_PORT}` : 'failed to start — see ~/.recall/daemon.log'); return; }
    if (action === 'stop') { try { await daemonCall('/shutdown', {}, 2000); console.log('stopped'); } catch { const pid = daemonRunning(); if (pid) { process.kill(pid, 'SIGTERM'); console.log('sent SIGTERM'); } else console.log('not running'); } return; }
    const pid = daemonRunning();
    if (!pid) { console.log('not running'); return; }
    try { const h = await new Promise<string>((res, rej) => { const req = httpGet({ host: '127.0.0.1', port: DAEMON_PORT, path: '/health' }, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => res(s)); }); req.on('error', rej); }); console.log(h); } catch { console.log(`pid ${pid} alive but not answering on ${DAEMON_PORT}`); }
  });

program.command('reindex').description('Re-embed all entities with the current embedder (RECALL_EMBEDDER=transformer|hashing)').action(async () => {
  try { const r = await daemonCall<{ reindexed: number; embedder: string }>('/reindex', {}, 600_000); console.log(JSON.stringify(r)); return; } catch { /* fall through */ }
  const store = new Store(); const emb = pickEmbedder();
  const n = await reindex(store, emb, (d, t) => process.stderr.write(`\r  ${d}/${t}`));
  console.log(`\nreindexed ${n} entities with ${emb.name}`); store.close();
});

program.command('mcp').description('Run the MCP server (stdio)').action(() => {
  execFileSync(process.execPath, MCP_BIN_ARGS, { stdio: 'inherit' });
});

// ---------------- install helpers ----------------

function settingsPath(project: string, user: boolean) { return user ? join(process.env.HOME ?? '~', '.claude', 'settings.json') : join(project, '.claude', 'settings.json'); }

function hookEntries() {
  const cmd = (ev: string) => `${HOOK_BIN} ${ev}`;
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start'), timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt'), timeout: 10 }] }],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: cmd('guard'), timeout: 10 }] }],
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: cmd('observe'), timeout: 10 }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: cmd('ingest'), timeout: 60 }] }],
  } as Record<string, unknown[]>;
}

export function installHooks(project: string, user: boolean) {
  const p = settingsPath(project, user);
  let s: Record<string, unknown> = {};
  if (existsSync(p)) { try { s = JSON.parse(readFileSync(p, 'utf-8')); } catch { s = {}; } }
  const hooks = (s.hooks as Record<string, unknown[]> | undefined) ?? {};
  for (const [ev, entries] of Object.entries(hookEntries())) {
    const existing = (hooks[ev] ?? []) as { hooks?: { command?: string }[] }[];
    const kept = existing.filter((h) => !(h.hooks ?? []).some((x) => (x.command ?? '').includes('recall-hook') || (x.command ?? '').includes('cli/hook.js') || (x.command ?? '').includes('hookbin/recall-hook')));
    hooks[ev] = [...kept, ...entries];
  }
  s.hooks = hooks;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  console.error(`hooks installed → ${p}`);
}

export function uninstallHooks(project: string, user: boolean) {
  const p = settingsPath(project, user);
  if (!existsSync(p)) return;
  const s = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  const hooks = (s.hooks as Record<string, { hooks?: { command?: string }[] }[]> | undefined) ?? {};
  for (const ev of Object.keys(hooks)) hooks[ev] = hooks[ev].filter((h) => !(h.hooks ?? []).some((x) => (x.command ?? '').includes('recall-hook') || (x.command ?? '').includes('cli/hook.js') || (x.command ?? '').includes('hookbin/recall-hook')));
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
}

export function installMcp(project: string, user: boolean) {
  if (user) {
    try { execFileSync('claude', ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'recall', '--', process.execPath, ...MCP_BIN_ARGS], { stdio: 'pipe' }); console.error('MCP server registered (user scope)'); }
    catch (e) { console.error('could not register MCP at user scope: ' + (e as Error).message.slice(0, 120)); }
    return;
  }
  const p = join(project, '.mcp.json');
  let s: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(p)) { try { s = JSON.parse(readFileSync(p, 'utf-8')); } catch { s = {}; } }
  s.mcpServers = { ...(s.mcpServers ?? {}), recall: { type: 'stdio', command: process.execPath, args: MCP_BIN_ARGS } };
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  console.error(`MCP server registered → ${p}`);
}

function which(bin: string): boolean { try { execFileSync('which', [bin], { stdio: 'pipe' }); return true; } catch { return false; } }

program.parseAsync(process.argv);
