// Local dashboard HTML served by the daemon at GET / (127.0.0.1 only). Zero-dependency, self-contained.
import type { Store } from '../core/store.js';

function esc(s: unknown) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)); }

export function renderDashboard(store: Store, info: { embedder: string; uptimeS: number; pid: number }): string {
  const counts = store.countByType();
  const seg = store.segmentStats();
  const inj = store.injectionStats();
  const recent = (store.db.prepare('SELECT surface, query, entity_ids, cwd, latency_ms, created_at FROM injections ORDER BY id DESC LIMIT 25').all() as { surface: string; query: string; entity_ids: string; cwd: string | null; latency_ms: number; created_at: string }[]);
  const top = (store.db.prepare("SELECT id, type, text, evidence, confidence, usefulness, project_path FROM entities ORDER BY (evidence * (1 + usefulness)) DESC, confidence DESC LIMIT 25").all() as { id: string; type: string; text: string; evidence: number; confidence: number; usefulness: number; project_path: string }[]);
  const byProject = (store.db.prepare("SELECT project_path p, COUNT(*) n FROM entities WHERE project_path != '' GROUP BY project_path ORDER BY n DESC LIMIT 15").all() as { p: string; n: number }[]);
  const byAgent = (store.db.prepare('SELECT agent, COUNT(*) n, COUNT(DISTINCT session_id) s FROM segments GROUP BY agent').all() as { agent: string; n: number; s: number }[]);
  const fb = (store.db.prepare('SELECT signal, COUNT(*) n FROM feedback GROUP BY signal').all() as { signal: string; n: number }[]);
  const rules = (store.db.prepare("SELECT id, text, evidence, confidence, project_path, json FROM entities WHERE type = 'rule' ORDER BY confidence DESC, evidence DESC LIMIT 20").all() as { id: string; text: string; evidence: number; confidence: number; project_path: string; json: string }[]);
  const stat = (n: unknown, l: string) => `<div class="stat"><div class="v">${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Recall</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#F4F6F9;--surface:#fff;--ink:#151A2D;--muted:#5B6379;--rule:#D8DEE8;--accent:#2358B8;--code:#EEF2F7}
@media(prefers-color-scheme:dark){:root{--bg:#0E1220;--surface:#161B2B;--ink:#E6E9F2;--muted:#98A1B7;--rule:#29314A;--accent:#8AB0F5;--code:#1C2234}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}.sub{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:22px 0}.stat{background:var(--surface);border:1px solid var(--rule);padding:12px 14px}.stat .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}.stat .l{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
h2{font-size:17px;margin:28px 0 8px}table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--rule);font-size:13.5px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--rule);vertical-align:top}th{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:var(--code)}tr:last-child td{border-bottom:none}
code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--code);padding:1px 4px;border-radius:3px}.muted{color:var(--muted)}.pill{display:inline-block;padding:0 7px;border-radius:10px;font-size:11px;background:var(--code);color:var(--muted)}.tbl{overflow-x:auto}
</style></head><body><div class="wrap">
<h1>Recall</h1><div class="sub">daemon pid ${info.pid} · up ${info.uptimeS}s · embedder ${esc(info.embedder)} · db ${esc(store.path)}</div>
<div class="grid">${stat(Object.values(counts).reduce((a, b) => a + b, 0), 'entities')}${stat(counts.pointer ?? 0, 'pointers')}${stat(counts.rule ?? 0, 'rules')}${stat(counts.decision ?? 0, 'decisions')}${stat(counts.procedure ?? 0, 'procedures')}${stat(seg.sessions, 'sessions')}${stat(seg.n, 'segments')}${stat(seg.llm, 'LLM-refined')}${stat(inj.injections, 'injections')}${stat(inj.used, 'used signals')}</div>
<h2>Sources</h2><div class="tbl"><table><tr><th>agent</th><th>sessions</th><th>segments</th></tr>${byAgent.map((a) => `<tr><td>${esc(a.agent)}</td><td>${a.s}</td><td>${a.n}</td></tr>`).join('')}</table></div>
<h2>Projects</h2><div class="tbl"><table><tr><th>project</th><th>entities</th></tr>${byProject.map((p) => `<tr><td><code>${esc(p.p)}</code></td><td>${p.n}</td></tr>`).join('')}</table></div>
<h2>Recent injections</h2><div class="tbl"><table><tr><th>when</th><th>surface</th><th>query</th><th>#</th><th>ms</th></tr>${recent.map((r) => `<tr><td class="muted">${esc(r.created_at.slice(5, 16).replace('T', ' '))}</td><td><span class="pill">${esc(r.surface)}</span></td><td>${esc(r.query.slice(0, 110))}</td><td>${JSON.parse(r.entity_ids).length}</td><td>${r.latency_ms ?? ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">none yet</td></tr>'}</table></div>
<h2>Rules</h2><div class="tbl"><table><tr><th>id</th><th>rule</th><th>×</th><th>conf</th><th>enforce</th></tr>${rules.map((r) => { const j = JSON.parse(r.json) as { ruleText: string; enforcement: string }; return `<tr><td><code>${r.id.slice(0, 8)}</code></td><td>${esc(j.ruleText.slice(0, 160))}</td><td>${r.evidence}</td><td>${Math.round(r.confidence * 100)}%</td><td>${esc(j.enforcement)}</td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">none yet</td></tr>'}</table></div>
<h2>Strongest knowledge</h2><div class="tbl"><table><tr><th>id</th><th>type</th><th>text</th><th>×</th><th>conf</th><th>useful</th></tr>${top.map((e) => `<tr><td><code>${e.id.slice(0, 8)}</code></td><td>${esc(e.type)}</td><td>${esc(e.text.slice(0, 140))}</td><td>${e.evidence}</td><td>${Math.round(e.confidence * 100)}%</td><td>${e.usefulness.toFixed(2)}</td></tr>`).join('')}</table></div>
<h2>Feedback</h2><div class="tbl"><table><tr><th>signal</th><th>count</th></tr>${fb.map((f) => `<tr><td>${esc(f.signal)}</td><td>${f.n}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">none yet</td></tr>'}</table></div>
<p class="muted" style="margin-top:28px;font-size:12px">Everything on this page is local to this machine. <code>recall explain &lt;id&gt;</code> shows provenance; <code>recall why</code> shows the last injection.</p>
</div></body></html>`;
}
