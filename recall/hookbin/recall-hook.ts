// Fast hook shim compiled with `bun build --compile`: forwards Claude Code hook stdin to the recall daemon.
// If the daemon is unreachable it execs the Node fallback (dist/cli/hook.js), which also restarts the daemon.
// Keep this dependency-free and tiny; it must start in <30 ms.
const event = process.argv[2] ?? '';
const nodeFallback = process.env.RECALL_HOOK_FALLBACK ?? '';
const port = Number(process.env.RECALL_PORT ?? 47821);

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Bun.stdin.stream().getReader();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), 1500);
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (value) chunks.push(value); } } catch {} finally { clearTimeout(timer); }
  return Buffer.concat(chunks).toString('utf-8');
}

async function fallback(raw: string): Promise<never> {
  if (nodeFallback) {
    const proc = Bun.spawn(['node', '--no-warnings', nodeFallback, event], { stdin: 'pipe', stdout: 'inherit', stderr: 'ignore' });
    proc.stdin.write(raw); proc.stdin.end();
    await proc.exited;
  }
  process.exit(0);
}

const raw = await readStdin();
let input: Record<string, unknown> = {};
try { input = raw.trim() ? JSON.parse(raw) : {}; } catch {}

// Only these events need the daemon on the hot path; everything else goes straight to the Node fallback.
if (!['prompt', 'session-start', 'ingest', 'observe'].includes(event)) await fallback(raw);

const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 1500);
try {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, input }), signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) await fallback(raw);
  const body = await res.text();
  if (body && body !== 'null' && body !== '{}') process.stdout.write(body + '\n');
  process.exit(0);
} catch { clearTimeout(t); await fallback(raw); }
