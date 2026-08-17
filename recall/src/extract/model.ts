// Model adapters. Two implementations behind one interface:
//   - AnthropicModel: official SDK, structured outputs via output_config.format (needs ANTHROPIC_API_KEY or `ant auth login`)
//   - ClaudeCliModel: shells out to `claude -p --output-format json` (uses your Claude Code login; no key needed)
// Selection: RECALL_MODEL_ADAPTER=anthropic|claude-cli|none, else auto (anthropic if a key/profile is present, else claude-cli).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface JsonModel {
  readonly name: string;
  /** Ask for a JSON object conforming to `schema`. Returns parsed object and cost estimate. */
  json(opts: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<{ data: unknown; costUsd: number; model: string }>;
}

export const DEFAULT_MODEL = process.env.RECALL_MODEL ?? 'claude-opus-5';

export function hasAnthropicCreds(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const cfg = process.env.ANTHROPIC_CONFIG_DIR ?? join(homedir(), '.config', 'anthropic');
  return existsSync(join(cfg, 'credentials'));
}

export async function pickModel(): Promise<JsonModel | null> {
  const pref = process.env.RECALL_MODEL_ADAPTER ?? 'auto';
  if (pref === 'none') return null;
  if (pref === 'anthropic' || (pref === 'auto' && hasAnthropicCreds())) return new AnthropicModel();
  if (pref === 'claude-cli' || pref === 'auto') return new ClaudeCliModel();
  return null;
}

// ---------------- Anthropic SDK ----------------

const PRICE: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 }, 'claude-opus-4-8': { in: 5, out: 25 }, 'claude-sonnet-5': { in: 3, out: 15 }, 'claude-haiku-4-5': { in: 1, out: 5 },
};

export class AnthropicModel implements JsonModel {
  readonly name = 'anthropic';
  private client: import('@anthropic-ai/sdk').default | null = null;
  constructor(readonly model = DEFAULT_MODEL) {}
  private async c() {
    if (!this.client) { const { default: Anthropic } = await import('@anthropic-ai/sdk'); this.client = new Anthropic(); }
    return this.client;
  }
  async json({ system, user, schema, maxTokens = 8000 }: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }) {
    const client = await this.c();
    const res = await client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    } as never);
    const r = res as unknown as { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; stop_reason: string };
    if (r.stop_reason === 'refusal') throw new Error('model refused');
    const text = r.content.find((b) => b.type === 'text')?.text ?? '{}';
    const p = PRICE[this.model] ?? { in: 5, out: 25 };
    const inTok = r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0) * 1.25 + (r.usage.cache_read_input_tokens ?? 0) * 0.1;
    const costUsd = (inTok * p.in + r.usage.output_tokens * p.out) / 1e6;
    return { data: JSON.parse(text), costUsd, model: this.model };
  }
}

// ---------------- claude -p ----------------

export class ClaudeCliModel implements JsonModel {
  readonly name = 'claude-cli';
  constructor(readonly model = process.env.RECALL_MODEL ?? '') {}
  async json({ system, user, schema, maxTokens }: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }) {
    const prompt = `${system}\n\nReturn ONLY a JSON object (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(schema)}\n\n=== INPUT ===\n${user}`;
    const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
    if (this.model) args.push('--model', this.model);
    const { stdout, code, stderr } = await run('claude', args, prompt, 240_000);
    if (code !== 0) throw new Error(`claude -p exited ${code}: ${stderr.slice(0, 300)}`);
    let outer: { result?: string; is_error?: boolean; total_cost_usd?: number; model?: string };
    try { outer = JSON.parse(stdout); } catch { throw new Error('claude -p returned non-JSON: ' + stdout.slice(0, 200)); }
    if (outer.is_error) throw new Error('claude -p error: ' + String(outer.result).slice(0, 300));
    const text = String(outer.result ?? '').trim();
    const jsonText = extractJson(text);
    return { data: JSON.parse(jsonText), costUsd: outer.total_cost_usd ?? 0, model: outer.model ?? (this.model || 'claude-code-default') };
  }
}

function extractJson(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

function run(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.CLAUDECODE; // allow nested invocation from inside Claude Code
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); resolve({ stdout, stderr, code: code ?? -1 }); });
    child.stdin.write(stdin); child.stdin.end();
  });
}
