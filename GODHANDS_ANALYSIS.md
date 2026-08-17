# GodHands Dossier

*An evidence-based analysis of GodHands (godhands.dev), Y Combinator F26 — what they do, how they do it, and whether they are a Composio wrapper. Compiled 2026-08-16 from the live site bundle, the published npm package, GitHub, YC, and third-party archives.*

---

## Verdict (read this first)

**No — GodHands is not a Composio wrapper, and never was.** There is zero technical or positioning overlap:

- Composio is an *action* layer: managed OAuth + a catalog of ~1,000 SaaS toolkits (~20k tools) exposed to agents through SDKs and one MCP endpoint. Its whole value is "connect the agent to Slack/GitHub/Salesforce and execute API calls on the user's behalf."
- GodHands has shipped exactly one runnable artifact: an npm CLI + MCP server that **mines your Claude Code transcripts into a structured knowledge base and re-injects that context into future sessions**. Its marketing site sells a *different* product: a CI check that detects code↔documentation drift on every PR. Its original (June–July 2026) pitch was a *third* thing: a deterministic, non-vision computer-use runtime for desktop/browser apps.
- None of the three products calls out to third-party SaaS APIs on a user's behalf. The CLI's only dependency is `commander`. The words "Composio", "MCP catalog", "OAuth", or "toolkit" appear nowhere in the site bundle or the package. Even the v1 computer-use pitch was explicitly *anti*-integration ("without requiring custom integrations or per-app handling").

What GodHands actually is today: a two-founder, ex-HFT team iterating fast (three positionings in ~8 weeks) on one underlying thesis — **capture the context engineers and agents generate, and hand it back at the right moment**. The knowledge-base CLI is the concrete expression of that thesis; the doc-drift landing page is the enterprise-shaped wrapper around it.

---

## Page 1 — Who they are, and the three products they've claimed

### Company facts

| | |
|---|---|
| Company | GodHands (YC one-liner today: *"The company knowledge base that updates itself"*) |
| Batch / status | Y Combinator **Fall 2026**, active; YC partner Nicolas Dessaigne |
| Founded / size | 2026; **2 people**; 0 open roles |
| Location | Bengaluru (YC profile); "San Francisco" (marketing/API-Evangelist record); Gurugram (Forbes Council bio). Indian entity **GODHANDS PRIVATE LIMITED**, CIN U62099TS2026FTC215103 (Telangana, foreign-subsidiary class) recently incorporated |
| Founders | **Sai Vamshi Batchu** (CEO) — ~3 yrs quant researcher at Graviton (HFT), IIT Kharagpur CS. **Aditya Bommakanti** — low-latency systems engineer at an HFT firm, NeurIPS-published, research stints at Aarhus & U. Tokyo, IIT Delhi CS |
| Contact / sales motion | founders@godhands.dev, Calendly intro call; "Book a demo" — pricing is "book a call" |
| Public code | GitHub org `GodHands-Org` (created 2026-06-25); product repo `byob` is **private**; public repos are only test forks of Sourcebot (×3, Aug 9) and Infisical (Aug 7) |

### Timeline of positioning (evidence-dated)

**v1 — "Deterministic computer-use infrastructure for AI agents" (≈ June → ~20 July 2026)**
Captured by API Evangelist's crawl (llms.txt generated 17–19 July) and by Extruct's YC data pull: *"a high-fidelity execution layer that acts as a translation interface between any model or agent runtime and the operating system… 'if a human can see it, GodHands can interact with it'… not probabilistic vision-based UI automation… comprehensive, immutable audit logs… positioned for regulated teams, claims-approval workflows, and moving records from legacy terminals into browser-based systems."* Tagline: *"The Automation API for the entire Desktop."* Residue still live today: the site's `<meta description>` ("The High-Fidelity Infrastructure for Deterministic Desktop Automation. Built for OS-level precision and speed"), the og:title ("Deterministic Action Infrastructure"), and the control-plane pricing tier copy ("Pro — $50 / month — Deterministic runtime for production teams").

**v2 — "Documentation that never falls behind." (live by 25 July 2026, still the landing page)**
Hero: *"GodHands detects drift between your code and docs, finds missing documentation, and updates everything on every pull request. Your team just validates the edits."* Claimed stats: **90%+ drift precision · <1 min PR-to-doc-update · 0 missed breaking changes.** Nav: Product / Drift Detection / Gap Detection / Integrations / Security. Three-step story: *Connect your repo → Build the knowledge graph ("a semantic graph linking every function to every doc section") → Detect & update on every PR ("we draft doc updates and open a review").* Integrations: GitHub, GitLab, Bitbucket, Azure DevOps; Notion, Confluence, GitBook, ReadMe, Mintlify, Docusaurus, any in-repo markdown. Security copy: zero data retention ("analyzed in-flight and immediately discarded… we never train on your data"), TLS 1.3 + AES-256, SOC 2 in preparation, "runs as a CI check — no CLI installs."

**v3 — "Knowledge base for coding agents" (npm `godhands` 0.2.0 → 0.2.9, 30 July → 3 Aug 2026)**
The only thing you can actually install. Package description: *"learns from Claude Code sessions and injects relevant context into future ones."* Publisher: aditya@godhands.dev. YC blurb updated to *"a living knowledge base for engineering teams, turning the code, docs, and decisions across your stack into a single source of truth."* Forbes bio: *"automatically captures context created during development and delivers the right information back to AI agents and engineers at the right time, eliminating repetitive exploration."*

**Read:** v2 and v3 are the same idea from two directions — v3 captures decisions from agent sessions; v2 promises to project them onto docs. v1 was a different market (RPA/computer-use) that they abandoned; only its vocabulary ("deterministic") survived.

---

## Page 2 — What they actually do, and how (from the shipped code)

I unpacked `godhands@0.2.9` from npm. The build script runs `javascript-obfuscator`, but the published output is effectively just minified — every string, endpoint, and type declaration is readable. This is the real architecture.

### Ingest pipeline

```
~/.claude/projects/<slug>/*.jsonl(.gz)          (Claude Code transcripts on your disk)
   │  discoverTranscripts()  – newest first, --since N days, --project, --max
   ▼
parseTranscript()  – keeps user/assistant/system; merges consecutive assistant msgs;
                     strips <command-*> tags; pulls out text / thinking / tool_use / tool_result
   │  sessions with ≥10 messages, JSON → gzip
   ▼
POST https://kb.godhands.dev/v1/ingest   (x-api-key, SSE progress stream, 10-min timeout,
   │                                     options.useLlm = true unless --no-llm)
   ▼  server: segment → extract → embed → dedup/merge → return KBStore
~/.godhands/kb/<slug>/{subjects,pointers,actions,rules,index}.json  (local, plain JSON)
```

### The knowledge-base schema (the actual IP)

Four entity types, each carrying an `embedding[]` and an `evidence` count that grows as the same fact recurs across sessions:

| Entity | What it encodes |
|---|---|
| **SubjectDescriptor** | A subsystem/module/symbol/config/tool: `summary`, `responsibilities[]`, `constraints[]`, `interactions[]` (with other subjects) |
| **OutcomeSubjectPointer** | For an *outcome class* (e.g. "auth middleware bug"): `signals[]`, `rootCause`, `resolution`, `procedures[]`, ranked `pointers[]` ("look here, because…"), and **`decoys[]`** ("do *not* look here unless <condition> — caveat: …") |
| **ActionPattern** | Per subject × outcome: `actions[]` (description + rationale), **`antiPatterns[]`**, `coSubjects[]`, `diagnosticQuestion`, `confidence` |
| **Rule** | Extracted from **user corrections** during sessions — categories `wrong_pattern / wrong_tool / wrong_file / wrong_convention / unnecessary_work / missing_context`, scope `global / project / file`, `frequency` |

Plus a `FileIndex` mapping file paths → the IDs of everything that mentions them. Extraction also tracks per-segment `outcomeStatus: accepted | abandoned | partial`, `filesRead`, `filesMutated`, and `TaskCategory` (bug_fix, feature, refactor, …). This is more than "RAG over chat logs": decoys and corrections-as-rules are the two ideas that make it distinctive.

### Retrieval (`retrieve.js`, runs on the client)

1. BM25 over a textualized form of every entry.
2. **Pseudo-embedding for the query without a local model:** take the top-8 lexical hits, weighted-average their stored embeddings into a query vector (Rocchio-style), then cosine against everything.
3. Score = cosine + 0.15 × BM25 + 0.15 if the entry is linked to a file you passed (`--files` / MCP `files[]`) + 0.03 × evidence. Thresholds ≈ 0.35–0.38. Top-K defaults 3 subjects / 3 pointers / 3 actions / 5 rules.
4. Candidates (embeddings stripped) → `POST /v1/query` → server reranks and returns `{ results, relevant: boolean, caveats: string[] }`. If `relevant` is false, nothing is injected.

### Delivery surfaces

- **`godhands` (proxy mode)** — opens a **tmux** session split into two panes: left is the "KB middleware" TUI where you type; right is a completely untouched `claude` process. Each prompt is scored; you get an **[A]pprove / [S]kip / [D]iscard** gate; on approve the prompt is pasted into the Claude pane (via `tmux load-buffer`/`paste-buffer`) wrapped in a `<kb-context source="godhands-kb">` block with Pointers / Context / Actions (+AVOID) / Constraints / Caveats. Short replies (`yes`, `ok`, numbers) bypass the KB.
- **`godhands-mcp`** — a stdio MCP server (hand-rolled JSON-RPC, protocol `2024-11-05`, no SDK dependency) exposing one tool, **`query_kb({query, project?, files?})`**. `godhands setup` auto-runs `claude mcp add -s user godhands-kb -- godhands-mcp`.
- **CLAUDE.md injection** — `setup` writes a `<!-- godhands:start -->…<!-- godhands:end -->` block into `~/.claude/CLAUDE.md` telling Claude to call `query_kb` 2–4 times per non-trivial task, phrase each query as *subject + outcome*, and treat returned rules as requirements.
- Local telemetry: `~/.godhands/telemetry/client/queries-YYYY-MM-DD.jsonl` (30-day retention; outcome hit/no_hits/irrelevant/skipped, timings).

### Backend & control plane

- `kb.godhands.dev` — live (`/health` → `{"status":"ok"}`); nginx 1.28 on Ubuntu at an AWS us-west-1 address; Fastify-style JSON errors; auth via `x-api-key`; routes `/v1/ingest`, `/v1/query`, `/v1/keys`, admin `/admin/orgs` via `x-admin-key`. Their own example queries name the service **`kb-api`** with **Supabase auth + row-level security** and per-org usage tracking.
- Marketing site: Vite + React + Tailwind + Radix on Cloudflare; `/control-plane` route = "Workspace Console" (Supabase auth, workspaces, API keys, usage, Stripe checkout — `stripePriceId` is empty, so checkout is disabled). `app.godhands.dev` = a Next.js "MVP console" on Vercel, same Supabase project.
- Distribution hygiene: license **UNLICENSED**, obfuscation step, and a **hardcoded expiry** — `new Date(2026, 7, 10)` → after 10 Aug 2026 the CLI prints *"This build has expired. Contact founders@godhands.dev"* and exits. As of today the public 0.2.9 build refuses to run; this is pilot-only distribution.

---

## Page 3 — Composio comparison, and their "framework"

### Side by side

| Dimension | Composio | GodHands v1 (computer-use, dropped) | GodHands today (KB CLI + doc-drift) |
|---|---|---|---|
| Core object | Third-party SaaS **actions** (API calls) | OS-level **UI actions** on desktop/browser apps | **Knowledge**: extracted decisions, procedures, rules from coding sessions/repos |
| Third-party auth | Managed OAuth / API-key vault, per-user connected accounts — *the product* | None (drives the UI a human would) | GitHub/GitLab app + doc-platform connectors (marketed, not shipped publicly) |
| Catalog | ~1,000 toolkits / ~20k tools | "any app a human can see" | n/a |
| Interface to agents | SDKs (Python/TS), REST, one MCP endpoint | SDK/API (claimed) | CLI, tmux proxy, single-tool MCP server, CLAUDE.md nudge |
| Executes anything for you? | Yes | Yes (claimed) | **No** — it only *informs* the agent |
| Uses Composio underneath? | — | No evidence | **No** — zero references; deps = `commander` only |

If you want the honest lineage: v1 competed with computer-use runtimes (Anthropic computer use, OpenAI Operator/CUA, Browser Use, hosted desktops). Today it competes with agent-memory and doc-automation tools — Claude Code's own CLAUDE.md/auto-memory, mem0/Letta-style memory layers, Sourcebot (which they are actively testing), Swimm, Mintlify's auto-docs. Composio is not in either set.

### The framework / stack (there is no public SDK)

- **Language & shape:** TypeScript monorepo (`GodHands-Org/byob`, private; package lives at `packages/godhands`). Node ≥ 18, ESM.
- **CLI:** `commander`; sub-commands `setup, build, query, stats, proxy, resume, ls, mcp, inspect, org, keys`. Zero runtime deps beyond commander — HTTP via Node `https`, gzip via `zlib`, terminal UI via raw ANSI + `readline`, pane management by shelling out to **tmux**, clipboard via `pbcopy`/`xclip`.
- **MCP:** hand-written stdio JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`), not `@modelcontextprotocol/sdk`.
- **Server:** Node (Fastify-style) behind nginx on a single AWS host; **Supabase** (Postgres + Auth + RLS) for orgs/keys/usage; **Stripe** wired but inactive; server-side LLM for extraction/rerank/caveats (provider not disclosed); embeddings generated server-side.
- **Web:** Vite/React/Tailwind/Radix (marketing, Cloudflare), Next.js (console, Vercel).
- **Vocabulary carry-over:** "deterministic" is a v1 word that now appears only in metadata and a pricing string; nothing in the KB product is deterministic in a technical sense (retrieval thresholds + an LLM relevance gate).

---

## Page 4 — Assessment, and what to take from it

### What's strong

1. **The ontology.** Pointers *with decoys*, action patterns *with anti-patterns*, and user corrections promoted to scoped **rules** with frequency counts is a real design, not "embed the transcript." It targets the two costs of agentic coding: re-exploration and repeated mistakes.
2. **Zero-friction acquisition.** The raw material (Claude Code transcripts) already exists on every user's disk; `setup` builds the KB, registers the MCP tool, and edits CLAUDE.md in one command.
3. **A human gate.** Approve/skip/discard in the proxy, and an LLM `relevant` check plus `caveats` before injection, so stale context is less likely to poison a session.
4. **Founders' background** (HFT quant + low-latency systems) matches a product whose value is measured in precision and latency; the doc-drift page leads with "90%+ precision" for a reason.

### What's weak or risky

1. **Message debt.** Meta tags say desktop automation, the landing page says doc drift, YC says knowledge base, npm says Claude Code memory. Three positionings in ~8 weeks is normal for YC, but the site itself is currently self-contradictory.
2. **Privacy contradiction.** The KB CLI uploads full transcripts (prompts, tool results, code snippets, `cwd`, git branch) to `kb.godhands.dev` for server-side extraction, while the same site promises "nothing is stored on our servers, ever" — for the *other* product. An enterprise buyer will read both pages.
3. **Narrow surface.** Claude Code only; tmux only; macOS/Linux; no Cursor/Codex/Copilot path yet.
4. **Pre-product signals.** UNLICENSED + obfuscation + expiring builds + disabled Stripe + private repo + "book a call" pricing = design-partner pilots, not self-serve revenue.
5. **Platform risk.** Anthropic ships memory and CLAUDE.md features into Claude Code itself; GitHub/Cursor ship repo-aware context. The moat has to be the cross-session, cross-engineer *org* KB and the doc-projection loop — neither is public yet.

### If you're building in this space (working dir is `godhandsclone`)

Copy the *shape*, not the code:
- Pipeline: transcripts → task segmentation → structured extraction `{outcome, subjects, decoys, actions/anti-patterns, corrections}` → dedup/merge with evidence counts → local hybrid retrieval → LLM relevance gate + caveats → inject.
- Surfaces: MCP tool first (works with any MCP client, not just Claude Code), CLAUDE.md/AGENTS.md nudge second, proxy TUI optional.
- Fix their weakness: run extraction **locally** (or BYO-model) so nothing leaves the machine — that would also make the "zero data retention" claim true.
- Their doc-drift half is unbuilt in public; a knowledge graph linking symbols → doc sections, run as a GitHub App on PRs, is where they say they're going.

### Open questions I could not resolve from public evidence

- Whether the doc-drift CI check exists beyond the landing page (no GitHub App, docs site, or marketplace listing found; docs.godhands.dev is an unclaimed Vercel domain).
- Which model runs extraction/rerank server-side, and pricing beyond the `$50/month Pro` placeholder.
- Whether the v1 computer-use runtime was ever delivered to a customer.

---

## Sources

- godhands.dev — homepage HTML, `/assets/index-Ci4E0U7t.js` bundle (hero, FAQ, integrations, security, pricing tiers, control-plane), `/robots.txt`; probes of `kb.godhands.dev/health`, `/v1/query`, `app.godhands.dev`, `docs.godhands.dev`, DNS.
- npm registry — `godhands` 0.2.0–0.2.9 metadata, README, and unpacked `godhands-0.2.9.tgz` (`api-client`, `retrieve`, `middleware`, `mcp-server`, `pipeline/*`, `types.d.ts`).
- Y Combinator — https://www.ycombinator.com/companies/godhands
- API Evangelist profile — https://github.com/api-evangelist/godhands (`llms/godhands-llms.txt`, `apis.yml`, `screenshots/godhands-2026-07-25T220006.png`, Kin scores 2026-07-23 → 08-12)
- Extruct AI, YC F26 list — https://www.extruct.ai/data-room/ycombinator-companies-f26/
- Forbes Business Council profile — https://councils.forbes.com/profile/Sai-Vamshi-Founder-CEO-GodHands/9250a617-722c-4ee8-a111-e9d94112c9ee
- GitHub — https://github.com/GodHands-Org ; https://github.com/PalmerMichaels/godhands-public
- Falcon Ebiz — https://www.falconebiz.com/company/GODHANDS-PRIVATE-LIMITED-U62099TS2026FTC215103
- LinkedIn — https://www.linkedin.com/in/sai-vamshi-batchu-129256194/
- Composio positioning — https://composio.dev/content/ai-agent-integration-platforms ; https://truto.one/blog/what-are-alternatives-to-composio-for-ai-agent-integrations-2026/ ; https://automationatlas.io/tools/composio/
