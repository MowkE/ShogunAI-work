#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { Store, defaultDbPath } from '../core/store.js';
import { retrieve, formatContext } from '../core/retrieve.js';
import { compileRules } from '../core/compile.js';
import { ingest, ingestRepo, ingestMemory, forget } from '../extract/ingest.js';
import { pickModel, hasAnthropicCreds } from '../extract/model.js';
import { collectSegments, submitBatch, listBatches, batchStatus, applyBatch } from '../extract/batch.js';
import * as claudeCode from '../collectors/claude-code.js';
import { discoverAll } from '../collectors/index.js';
import { segmentsOf } from '../extract/ingest.js';
import { renderSegment } from '../extract/segment.js';
import { daemonCall, daemonRunning, ensureDaemon, DAEMON_PORT } from './daemon.js';
import { pickEmbedder } from '../core/embed.js';
import { reindex } from '../core/merge.js';
import { retrieveAsync } from '../core/retrieve.js';
import { startTeamServer } from '../team/server.js';
import { loadConfig, saveConfig, suggestPromotions, promote, push as teamPush, pull as teamPull } from '../team/client.js';
import { repoIdFor } from '../collectors/git.js';
import { analyzeDrift, changedFromGit, changedFromPR, renderReport } from '../drift/index.js';
import { writeFileSync as writeFileSyncFs } from 'node:fs';

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
    try { const m = await ingestMemory(store); if (m.files) console.error(`auto-memory: ${m.files} files → ${m.inserted} new / ${m.merged} merged`); } catch { /* optional */ }
    const proj = resolve(o.project);
    if (existsSync(join(proj, '.git'))) { try { const g = await ingestRepo(store, proj, { onProgress: (m) => console.error('  git: ' + m) }); console.error(`git history: ${g.commits} commits, ${g.prs} PRs → ${g.inserted} new entities`); } catch { /* optional */ } }
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
  .option('--batch', 'submit LLM refinement as one Message Batch (needs an API key; -50% cost); apply later with `recall batch apply <id>`')
  .option('--max-segments <n>', 'with --batch: cap segments submitted', '500')
  .action(async (o) => {
    const store = new Store();
    if (o.batch) {
      if (!hasAnthropicCreds()) { console.error('--batch needs ANTHROPIC_API_KEY (or `ant auth login`)'); process.exit(1); }
      const segs = collectSegments(store, { since: o.since ? Number(o.since) : undefined, project: o.project, max: Number(o.maxSegments) });
      if (!segs.length) { console.log('nothing to submit'); store.close(); return; }
      const r = await submitBatch(store, segs); console.log(JSON.stringify({ batchId: r.id, segments: r.count, next: `recall batch apply ${r.id}` })); store.close(); return;
    }
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

program.command('ingest-memory').description("Ingest Claude Code auto-memory files (~/.claude/projects/*/memory/*.md)").option('--force').action(async (o) => {
  const store = new Store(); console.log(JSON.stringify(await ingestMemory(store, { force: !!o.force }))); store.close();
});

program.command('forget')
  .description('Delete knowledge: --entity <id> | --session <id> | --project <substr> | --all  (also tombstones nothing on the team server yet — run `recall team push` after promoting replacements)')
  .option('--entity <id>').option('--session <id>').option('--project <substr>').option('--all', 'wipe the local KB').option('--yes', 'skip confirmation for --all')
  .action((o) => {
    if (o.all && !o.yes) { console.error('refusing to wipe without --yes'); process.exit(1); }
    const store = new Store(); const r = forget(store, { entity: o.entity, session: o.session, project: o.project, all: !!o.all }); console.log(JSON.stringify(r)); store.close();
  });

program.command('rule <id> <enforcement>').description('Set a rule\'s enforcement: inform | warn | block (warn/block make the PreToolUse guard act on it)').action((id: string, enforcement: string) => {
  const store = new Store(); const e = store.allEntities({ type: 'rule' }).find((x) => x.id.startsWith(id));
  if (!e || e.type !== 'rule') { console.error('no such rule'); process.exit(1); }
  if (!['inform', 'warn', 'block'].includes(enforcement)) { console.error('enforcement must be inform|warn|block'); process.exit(1); }
  e.enforcement = enforcement as 'inform' | 'warn' | 'block'; if (enforcement !== 'inform') { e.validity.confidence = Math.max(e.validity.confidence, 0.85); e.validity.evidence = Math.max(e.validity.evidence, 2); }
  store.upsertEntity(e); console.log(`${e.id} → ${enforcement}`); store.close();
});

const batch = program.command('batch').description('Message Batches backfill: list | status <id> | apply <id>');
batch.command('list').action(() => console.log(JSON.stringify(listBatches(), null, 2)));
batch.command('status <id>').action(async (id: string) => console.log(JSON.stringify(await batchStatus(id), null, 2)));
batch.command('apply <id>').action(async (id: string) => { const store = new Store(); try { console.log(JSON.stringify(await applyBatch(store, id, undefined, (m) => console.error('  ' + m)))); } catch (e) { console.error((e as Error).message); process.exit(1); } store.close(); });

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

program.command('dashboard').description('Open the local dashboard (served by the daemon)').action(async () => { ensureDaemon(); await new Promise((r) => setTimeout(r, daemonRunning() ? 0 : 3000)); const url = `http://127.0.0.1:${DAEMON_PORT}/`; try { execFileSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open', [url], { stdio: 'ignore' }); } catch { /* ignore */ } console.log(url); });

program.command('reindex').description('Re-embed all entities with the current embedder (RECALL_EMBEDDER=transformer|hashing)').action(async () => {
  try { const r = await daemonCall<{ reindexed: number; embedder: string }>('/reindex', {}, 600_000); console.log(JSON.stringify(r)); return; } catch { /* fall through */ }
  const store = new Store(); const emb = pickEmbedder();
  const n = await reindex(store, emb, (d, t) => process.stderr.write(`\r  ${d}/${t}`));
  console.log(`\nreindexed ${n} entities with ${emb.name}`); store.close();
});

// ---------------- team (alpha) ----------------
program.command('team-server')
  .description('Run a Recall Team Server (shared KB). Alpha: SQLite-backed, bearer-key auth.')
  .option('--port <n>', 'port', '47900').option('--host <h>', 'bind host', '0.0.0.0')
  .option('--db <path>', 'database file', join(process.env.HOME ?? '.', '.recall', 'team.db'))
  .option('--keys <keys>', 'comma-separated API keys (or RECALL_TEAM_KEYS)', process.env.RECALL_TEAM_KEYS ?? '')
  .action((o) => { startTeamServer({ port: Number(o.port), host: o.host, dbPath: o.db, keys: String(o.keys).split(',').map((k: string) => k.trim()).filter(Boolean) }); });

const team = program.command('team').description('Team sync: login | status | suggest | push | pull');
team.command('login <url> <key>').option('--author <name>', 'your name for provenance').action((url: string, key: string, o) => { const c = loadConfig(); c.team = { url, key, author: o.author }; saveConfig(c); console.log(`logged in to ${url}`); });
team.command('status').action(async () => { const c = loadConfig(); if (!c.team) { console.log('not logged in'); return; } try { const r = await fetch(c.team.url.replace(/\/$/, '') + '/v1/health'); console.log(c.team.url, await r.text()); } catch (e) { console.log(`unreachable: ${(e as Error).message}`); } });
team.command('suggest').description('List local entities worth promoting to the team KB').option('--project <path>', 'project root', process.cwd()).action((o) => {
  const store = new Store(); const c = suggestPromotions(store, resolve(o.project)).slice(0, 25);
  for (const e of c) console.log(`${e.id.slice(0, 8)}  ${e.type.padEnd(9)} ×${e.validity.evidence} ${Math.round(e.validity.confidence * 100)}%  ${e.text.slice(0, 100)}`);
  if (!c.length) console.log('(no candidates yet — evidence ≥3, PR-derived, or confident rules/decisions qualify)'); store.close();
});
team.command('promote <ids...>').description('Mark entities as team scope and push them').action(async (ids: string[]) => {
  const store = new Store(); const done: string[] = [];
  for (const id of ids) { const e = promote(store, id); if (e) done.push(e.id); else console.error(`no entity ${id}`); }
  if (done.length) { try { const r = await teamPush(store, done); console.log(`promoted ${done.length} → pushed ${r.pushed} (${r.inserted} new, ${r.merged} merged on server)`); } catch (e) { console.log(`promoted locally; push failed: ${(e as Error).message}`); } }
  store.close();
});
team.command('push').description('Push all team-scope entities').action(async () => { const store = new Store(); console.log(JSON.stringify(await teamPush(store))); store.close(); });
team.command('pull').description('Pull the team KB into your local store').option('--full', 'ignore last-pull cursor').option('--repo <id>', 'only entities for this repo id (default: current repo)').option('--all-repos', 'no repo filter').action(async (o) => {
  const store = new Store(); const repo = o.allRepos ? undefined : (o.repo ?? repoIdFor(process.cwd()));
  console.log(JSON.stringify(await teamPull(store, pickEmbedder(), { repo, full: !!o.full }))); store.close();
});

// ---------------- doc drift ----------------
program.command('drift')
  .description('Check whether docs still match changed code: stale paths/symbols, undocumented exports, sections to review (+ LLM consistency check with --llm)')
  .option('--repo <path>', 'repository root', process.cwd())
  .option('--base <ref>', 'compare base...HEAD (default: HEAD~1)')
  .option('--staged', 'use staged changes')
  .option('--pr <n>', 'use the files of a GitHub PR (via gh)')
  .option('--llm', 'ask the model to check touched sections for concrete contradictions')
  .option('--max-llm <n>', 'max sections to LLM-check', '8')
  .option('--json', 'JSON output')
  .option('--comment', 'post the report as a PR comment (requires --pr)')
  .option('--out <file>', 'write markdown report to a file')
  .action(async (o) => {
    const root = resolve(o.repo);
    const changed = o.pr ? changedFromPR(root, Number(o.pr)) : changedFromGit(root, { base: o.base, staged: !!o.staged });
    if (!changed.length) { console.error('no changed files found (check --base/--staged/--pr)'); }
    const model = o.llm ? await pickModel() : null;
    const r = await analyzeDrift(root, changed, { model, maxLlm: Number(o.maxLlm), onProgress: (m) => console.error('  ' + m) });
    const md = renderReport(r, { title: o.pr ? `Recall doc-drift report for PR #${o.pr}` : undefined });
    if (o.json) console.log(JSON.stringify({ ...r, changedSymbols: r.changedSymbols.map((s) => `${s.file}:${s.name}`) }, null, 2)); else console.log(md);
    if (o.out) writeFileSyncFs(o.out, md + '\n');
    if (o.comment && o.pr) { try { execFileSync('gh', ['pr', 'comment', String(o.pr), '--body', md], { cwd: root, stdio: 'pipe' }); console.error(`posted comment on PR #${o.pr}`); } catch (e) { console.error('failed to post comment: ' + (e as Error).message.slice(0, 200)); } }
  });

program.command('adr').description('Draft ADR files (docs/adr/NNNN-slug.md) from Decision entities of this repo that have not been exported yet')
  .option('--repo <path>', 'repository root', process.cwd()).option('--dir <path>', 'ADR directory', 'docs/adr').option('--min-confidence <x>', 'minimum decision confidence', '0.55')
  .action((o) => {
    const root = resolve(o.repo); const store = new Store();
    const decisions = store.allEntities({ type: 'decision', projectPath: root, repo: repoIdFor(root) }).filter((e) => e.type === 'decision' && e.validity.confidence >= Number(o.minConfidence) && !e.provenance.some((p) => p.docPath?.includes('/adr/')));
    if (!decisions.length) { console.log('no new decisions to export'); store.close(); return; }
    const dir = join(root, o.dir); mkdirSync(dir, { recursive: true });
    const existing = existsSync(dir) ? readdirSyncSafe(dir).filter((f) => /^\d{4}-/.test(f)).length : 0;
    let n = existing; const written: string[] = [];
    for (const d of decisions) {
      if (d.type !== 'decision') continue;
      n++; const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const file = join(dir, `${String(n).padStart(4, '0')}-${slug}.md`);
      const prov = d.provenance.map((p) => p.prNumber ? `PR #${p.prNumber}` : p.commit ? `commit ${p.commit.slice(0, 8)}` : p.sessionId ? `session ${p.sessionId.slice(0, 8)}` : p.source).join(', ');
      writeFileSyncFs(file, `# ${d.title}\n\n- Status: ${d.status}\n- Date: ${d.validity.firstSeen.slice(0, 10)}\n- Source: ${prov} (Recall ${d.id.slice(0, 8)}, confidence ${Math.round(d.validity.confidence * 100)}%)\n\n## Context\n\n${d.context || '_(not captured)_'}\n\n## Decision\n\n${d.choice}\n\n## Alternatives considered\n\n${d.alternatives.length ? d.alternatives.map((a) => '- ' + a).join('\n') : '_(none recorded)_'}\n\n## Consequences\n\n${d.consequences.length ? d.consequences.map((c) => '- ' + c).join('\n') : '_(none recorded)_'}\n`);
      d.provenance.push({ source: 'doc', docPath: file.replace(root + '/', ''), observedAt: new Date().toISOString() }); store.upsertEntity(d); written.push(file.replace(root + '/', ''));
    }
    console.log(JSON.stringify({ written }, null, 2)); store.close();
  });
function readdirSyncSafe(d: string): string[] { try { return readdirSync(d); } catch { return []; } }

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
