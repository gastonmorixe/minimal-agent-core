---
project: "minimal-agent"
title: "Changelog"
type: changelog
status: living
working-dir: "/Users/gaston/Projects/minimal-agent"
created-at: "2026-05-01T00:00:00-0400"
updated-at: "2026-08-01T15:35:00-0400"
format: "Keep a Changelog (pragmatic, date-stamped)"
latest-unreleased:
  - id: "2026-08-01-resume-credential-pin-provider-scope"
    type: fix
    status: landed
    detail: "docs/changes/2026-08-01-resume-credential-pin-provider-scope.md"
  - id: "2026-07-30-openai-chat-thinking-stop-before-text"
    type: fix
    status: landed
    detail: "docs/changes/2026-07-30-openai-chat-thinking-stop-before-text.md"
  - id: "2026-07-12-never-give-up-terminal-less-thinking-idle"
    type: fix
    status: shipped
    commits: ["15c295c", "cbcf119", "dc020a2"]
    detail: "docs/changes/2026-07-12-never-give-up-terminal-less-thinking-idle.md"
    research: "private/retry-fix/PROGRESS.md"
related:
  - "docs/changes/"
  - "private/retry-fix/PROGRESS.md"
---

# Changelog

All notable changes to this project are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project follows a pragmatic, date-stamped release rhythm. Longer
write-ups live under [`docs/changes/`](changes/); research handoffs under
`private/*/PROGRESS.md` when present.

## [Unreleased]

### Fix: Resume credential pin scoped to session provider

---
id: "2026-08-01-resume-credential-pin-provider-scope"
type: fix
status: landed
created-at: "2026-08-01T15:25:00-0400"
updated-at: "2026-08-01T15:35:00-0400"
detail: "docs/changes/2026-08-01-resume-credential-pin-provider-scope.md"
---

`--resume` no longer applies `meta.credentialName` when the effective
provider differs from the session's `meta.provider`. Credential names are
per-provider store keys; a grok pin on a cursor override previously fataled
with "no credentials for provider cursor" even when cursor was logged in.
Mismatch skips the pin via `diag.warn("auth.resume-pin", …)` (buffered
through the scrollback sink so the startup tree does not tear) and uses
the new provider default. Legacy sessions without `meta.provider` still
reuse the pin. Covered by `resolve-credential-name.test.ts` (pin gate) and
`provider-boot.test.ts` (diag emit, no mid-banner `console.error`).

See `docs/changes/2026-08-01-resume-credential-pin-provider-scope.md`.

### Fix: OpenAI Chat thinking_stop before first text (orphaned response prefixes)

---
id: "2026-07-30-openai-chat-thinking-stop-before-text"
type: fix
status: landed
created-at: "2026-07-30T18:11:00-0400"
updated-at: "2026-07-30T18:11:00-0400"
detail: "docs/changes/2026-07-30-openai-chat-thinking-stop-before-text.md"
---

DeepSeek Chat Completions transition chunks carry both the first visible token
and `reasoning_content: null` (e.g. `content:"Pre"`). The translator emitted
`text_delta` before `thinking_stop`, so the REPL's `onThinkingStop` blank-line
separator landed mid-word — orphaned bright prefixes (`Pre` / `Plug` / `All`)
in scrollback while JSONL stayed correct (session `a37f1f39`).

Fix: handle reasoning before text; close any open thinking block before
`text_start` / tool-call deltas (same order as Ollama). Canonical
`plugin-api/src/llm/openai-chat.ts`; plugins vendored copies synced.
Regression tests in `openai-chat.test.ts` + fixture order assert.

See `docs/changes/2026-07-30-openai-chat-thinking-stop-before-text.md`.

### Fix: Grok false mid-stream `stream_idle` from billing / shared request ids

---
id: "2026-07-24-stream-idle-billing-isolation"
type: fix
status: shipped
created-at: "2026-07-24T02:50:00-0400"
updated-at: "2026-07-24T02:55:00-0400"
detail: "docs/changes/2026-07-24-stream-idle-billing-isolation.md"
commits: ["ff4a1ab", "7c91bc7", "bf35061"]
---

Grok OAuth turns often logged mid-stream `stream_idle` ~30s after headers when a
concurrent `GET /v1/billing` shared the LLM stream's request id and lifecycle
hooks — billing JSON ended pre-stream and armed the wrong idle clock. Separate
from real upstream silence (e.g. mid tool-arg pauses), which still trips at 30s.

Fix: request-local lifecycle at the NetworkClient body tap; `bindPrimaryStreamRequest`
gives unique wire ids and attaches activity/watchdog only to the primary stream
(SSE/NDJSON/connect+ at headers, or `llm-stream` policy tag); denylist billing /
OAuth / quota labels; single-fire stall diagnostics; Notice-level retry recovery
so TUI warn slots clear. Mid-stream idle stays 30s (thinking-open 5 min).

See `docs/changes/2026-07-24-stream-idle-billing-isolation.md`.

### Fix: explicit `protocol: "h2"` NetworkClient routing (Cursor Connect)

---
id: "2026-07-24-explicit-h2-network-routing"
type: fix
status: shipped
created-at: "2026-07-24T02:30:00-0400"
updated-at: "2026-07-24T02:35:00-0400"
detail: "docs/changes/2026-07-24-explicit-h2-network-routing.md"
---

`NetworkClient.request({ protocol: "h2" })` always selects a registered
`Http2Transport`, even when `MINIMAL_AGENT_TRANSPORT=fetch` makes fetch the
process-wide primary. Without an always-registered h2 map entry, explicit pins
silently fell through to fetch — unusable for Cursor AgentService/Run
Connect/protobuf streaming (Bun fetch is malformed on that stream; host
Http2Transport is node:http2).

Also: `close()` tears down every distinct configured transport (including the
always-on h2 pool); protocol pins and `allowFetchFallback: false` never
fallback to fetch; request `transportHint` reflects the transport that will
actually serve the call (net-dbg accuracy). Focused tests cover pin-under-fetch
and exactly-once multi-transport close.

See `docs/changes/2026-07-24-explicit-h2-network-routing.md`.

### Fix: scrub embedded `data:*;base64` URIs in tool text (token waste)

---
id: "2026-07-23-embedded-payload-scrub"
type: fix
status: shipped
created-at: "2026-07-23T16:41:00-0400"
updated-at: "2026-07-23T16:55:00-0400"
---

Whole-body binary-guard does not catch base64 **inside** otherwise-valid UTF-8
(e.g. Fetch markdown with inlined `data:image/png;base64,…`). New pure scrub:

- `src/tools/embedded-payload-scrub.ts` — continuous data-URI base64 above 256
  chars → `<ma::agent::redacted-asset …/>` + `<ma::agent::context-sanitizer …/>`.
- `tool-round` runs scrub **before** transcript paint; pre-scrub body kept for
  blob recovery (`rawForBlob`). Skips `binary: true` and multimodal blocks.
- `session-dump` re-scrubs so `ma sessions dump` no longer prints megabase64.
- Loader max-lines: `pluginToolDefinitionFromTrigger` moved into
  `loader/helpers.ts` (binary opt-in inject stays).

### Fix: withhold binary tool results from model context (opt-in `binary`)

Tools that return PDF/image/zip-like bodies (Fetch `format: original`,
`cat foo.pdf` via Bash, …) no longer dump UTF-8 mojibake into the model.
Core adds a defense-in-depth guard in `tool-round` plus a schema injection
path for tools that declare `mayReturnBinary`:

- `src/tools/binary-guard.ts` — classify bytes/text, format
  `<ma::agent::binary-result …/>`, inject `binary?: boolean` into
  input schemas, base64 opt-in under a 48 KiB raw cap.
- Plugin-api `ManifestTrigger.tool.mayReturnBinary`; loader injects the
  opt-in arg via `getExtraTools()`.
- `tool-round` rewrites binary string content **before** transcript paint
  and **after** blob capture so the annotation carries a real path; media
  `blocks` (Read images) and user-message document uploads are untouched.

### Feat: editor buffer style spans + `turn.willStart` model rewrite seam

---
id: "2026-07-15-editor-buffer-styles-turn-will-start"
type: feat
status: in-progress
created-at: "2026-07-15T01:45:31-0400"
updated-at: "2026-07-15T01:45:31-0400"
---

Host support for live input highlights and dual-representation user text
(e.g. intercom `@`-mentions):

- **`editor.buffer.styles` channel** (`broadcast-sync`): plugins emit
  `{spans: [{start, end, style}]}` with code-point offsets into
  `buf.toString()` (`\n` counts as 1). Host calls
  `EditorController.setBufferStyles`. Empty spans clear.
- **`EditorRenderer`**: optional `styles` / `setStyles` paint SGR around
  matching ranges without shifting cursor or wrap math. Styles bake into
  submit `commitLines` so scrollback keeps the highlight.
- **`turn.willStart` chain** (payload `{text}`): REPL queue-drain emits
  before `agent.run(text)`. Listeners may rewrite model-facing text or
  `{halt: true}` veto. Scrollback still uses original `commitLines`.

First consumer: `ma-intercom-plugin` peer `@`-mentions.

### Fix: never-give-up terminal-less recovery + thinking-aware stream idle (Grok / OpenAI Responses)

---
id: "2026-07-12-never-give-up-terminal-less-thinking-idle"
type: fix
status: shipped
created-at: "2026-07-12T13:34:39-0400"
updated-at: "2026-07-12T16:40:00-0400"
incidents: ["523dba62", "113921b7"]
commits: ["15c295c", "cbcf119", "dc020a2"]
detail: "docs/changes/2026-07-12-never-give-up-terminal-less-thinking-idle.md"
research: "private/retry-fix/PROGRESS.md"
agents: ["ba7cd4f2", "97596567", "ce0e0589", "842604fe", "f61fc420", "106c4c8c"]
---

Grok high-effort reasoning streams that paused more than ~30s mid-think were
idle-aborted by the provider-neutral watchdog, then mis-tagged as
`stream_closed_without_terminal` when the aborted body drained without a
terminal SSE event. The post-`15c295c` / `cbcf119` policy then took **one**
near-zero pre-effect transport retry and **`failTurn`**, hard-stopping the
agent with `OpenAI Responses stream closed without a terminal event
(truncated)` (session `113921b7`, ~33s elapsed, `saw-reasoning: true`,
`completedToolCalls: 0`). That violated the harness principle that multi-day
agentic runs must outlive transient transport EOF without a human re-prompt.

**Watchdog** (`src/llm/transport/watchdog.ts`):

- While a thinking/reasoning block is open, idle budget is **5 minutes**
  (`DEFAULT_THINKING_IDLE_TIMEOUT_MS`), not the ordinary 30s
  `streamIdleTimeoutMs`. After `thinking_stop`, the ordinary idle applies again.
- If the watchdog has already set an abort reason (`stream_idle` /
  `attempt_too_long`), it **throws that tagged error and does not yield** any
  further events — so a synthetic adapter `stream_closed_without_terminal` on
  quiet drain cannot replace a real idle classification. Idle stalls stay on
  the forever **fast** retry curve.

**Pre-effect terminal-less policy** (`attempt-progress.ts` + `retry.ts`):

- **No completed tools** (empty or mid-reasoning / mid-stream with no closed
  tool_use): retry **forever** with polite capped exponential backoff (max
  5 min). Empty closes use a short base; midstream (saw reasoning or text)
  uses a multi-second base with a **≥1s floor** so the first retry cannot
  collapse to `after 0.0s` thrash. Only the caller's AbortSignal (Esc) stops
  the loop — no `failTurn` budget.
- **≥1 completed tool**: still **never re-POST** the same request body
  (`continueTurn` / bridge salvage). That remains the side-effect safety
  boundary from `15c295c`.
- Partial-text salvage and one local agent continuation from `cbcf119` are
  unchanged (bridge returns `end_turn` with preserved text when `sawText`
  without throwing into `withRetry`).

Diag curves: `terminal-less-empty` and `terminal-less-midstream` (replacing
the old one-shot `terminal-less-bounded` + `api.retry-terminal-less-stop`
fail path for pre-effect closes).

**Commits:** `15c295c` (post-tool salvage), `cbcf119` (mid-text continuation),
`dc020a2` (this never-give-up + thinking-idle fix). Full write-up:
[`docs/changes/2026-07-12-never-give-up-terminal-less-thinking-idle.md`](changes/2026-07-12-never-give-up-terminal-less-thinking-idle.md).
Research handoff: `private/retry-fix/PROGRESS.md`. Restart the running agent
process to pick up the binary.

### Feature: AGENTS.md auto-load (`agents-md` plugin + `--no-agents-md`)

First-party plugin `ma-agents-md-plugin` (extended plugins repo) now loads
[AGENTS.md](https://agents.md) into the system prompt at session start: global
from the resolved agent home (`MINIMAL_AGENT_HOME/AGENTS.md`), then project from
`<cwd>/AGENTS.md`. Injection uses the standard `promptFragments` path, so both
the legacy `Agent` loop and modern `AgentCore` (`PromptContributorAdapter`)
receive it. Core adds a convenience disable flag:

- `--no-agents-md` / `--no-agents` (aliases for `--disable-plugin agents-md`)
- `MINIMAL_AGENT_NO_AGENTS_MD=1`

Also documented in `--help`. Config: `plugins["agents-md"].enabled = false` or
per-source `global` / `project` / `maxBytes`.

### Feature: system-prompt overrides (`--system-*` flags, env, config)

Every model-facing part of the system prompt can now be replaced or omitted at
startup: the whole core prompt (`--system-prompt`), the neutral identity, the
base instructions, the loop-safety paragraph, the tool-output-conventions
paragraph, the session-context block (plugin prompts), and the provider preamble.
Each part has a `--system-<part>` (inline text), `--system-<part>-file` (path),
and `--no-system-<part>` (omit) form; an empty string also means omit. The same
parts are configurable via `systemPrompt.*` in `config.jsonc` (a `false`/`null`
value means omit, a string means replace, a `*File` key names a file) and via
`MINIMAL_AGENT_SYSTEM_*` env vars. Precedence is CLI > env > config > default.

The design is a single shared tri-state override model
(`src/llm/system-prompt-overrides.ts`: `default | replace | omit`) resolved once
at startup and threaded identically into the legacy `Agent`, the modern
`AgentCore`, and the resume-drift `computeStartupHashes` — applied in exactly one
place (`resolveSystemPromptForModel` + `buildInstructionsBlockText`), so both
runtimes and the hash stay byte-consistent. With no overrides, the output is
byte-identical to before (cache-key stable). Safety: the provider preamble is
server-validated on some plans (Anthropic OAuth), so replacing/omitting it is
refused unless `--unsafe-system-prompt-overrides` is passed; conflicting flags
and missing `--system-*-file` paths fail fast at startup with exit 2; and
`--system-prompt` replacing the whole body ignores the individual part overrides
(the provider preamble is unaffected). No model-facing prose is hardcoded in
TypeScript — only flag names, keys, and error strings.

### Feature: `--output-format {text,json,stream-json}` on the modern agent core

Non-interactive runs (`--prompt`, `-`, a bare positional) can now select an
output format explicitly. `text` (the default) is unchanged: human progress to
stderr, the final answer to stdout when piped. `json` and `stream-json` both
drive the port-injected `AgentCore` and emit its structured `AgentEvent` stream
as JSON Lines on stdout (`turn_started` → `item_started` → `item_completed` →
`turn_completed`, with `tool_result` carrying the `tool_result.id ===
item_started.id` join for tool turns). `json` is buffered; `stream-json` flushes
each event live and additionally emits token-level `text_delta` and
`thinking_delta` events as the model streams.

`--json` is now a documented alias for `--output-format json`. This changes its
wire output: it previously emitted a single synthetic final-answer line
(`item_completed` with id `"final"`); it now emits the full event stream, where
the answer is the real `item_completed` (itemType `text`) followed by
`turn_completed`. A consumer that read the last line for the answer should
instead take the `item_completed` text event (or the terminal `turn_completed`
for stop reason + usage). `--output-schema` enforcement is unchanged and stays
on the buffered validate-before-stdout path.

### Architecture: provider-decoupling ratchet + first cleanups

New fitness test (`src/architecture.provider-decoupling.test.ts`) enforces
the layering rule: provider-specific code (names, model ids, wire details)
lives in `plugins/<provider>/`, never `src/` core — comments may reference
providers, code may not. Violations must match a frozen, shrink-only
baseline, so new leaks fail CI immediately and cleanups must ratchet the
baseline down in the same commit. First cleanups shipped behind it:
Anthropic media limits moved behind the `ProviderAdapter.mediaLimits` hook
(core falls back to a neutral conservative floor), `--list-models` went
provider-neutral via the new `ProviderPlugin.listLiveModels` hook, the
beta-flag model gates unified into plugin-owned `beta-gates.ts` (both
transports now share one predicate — the drift class behind the fable-5
context-1m bug), and the tool-output redaction allowlist dropped its
vendor-specific header literal for a neutral session-id pattern.

### Feature: Claude Fable 5 in the model catalog

`claude-fable-5` (the public Mythos-class flagship launched 2026-06-09) is now
registered end-to-end: capabilities (Opus-4.8 twin, 1M context, 128K output,
adaptive thinking, effort up to `max`, no fast tier), flat $10 / $50 pricing,
`[1m]` alias, and the `context-1m-2025-08-07` beta on both transports. The
original symptom was a 429 on every OAuth request because the unregistered id
dropped the Claude Code preamble.

### Fix: fast-mode is capability-gated on the legacy transport

`speed:"fast"` (sticky `--fast` / `MINIMAL_AGENT_FAST=1`) used to reach the
wire for models with no fast tier (Fable 5, Sonnet, Haiku), which the server
rejects with 429 "Usage credits are required for fast mode". The legacy client
now consults the model registry's `speedFast` capability and drops both the
body field and the `fast-mode-2026-02-01` beta header (with a diagnostic
warning) when unsupported, matching the canonical transport. SessionInfo's
`fast` line now reflects the CLI flag too (the host mirrors the resolved state
into `MINIMAL_AGENT_FAST`) and cross-checks the capability so it never claims
a fast tier the model lacks.

### Build: scope the test gate to first-party source

`bun test` scanned from the repo root, so it descended into the gitignored,
vendored research clones under `private/` (a copy of `gemini-cli` and others)
that ship their own vitest suites and unresolvable dependencies. The gate
counted ~1300 of those as failures even though every first-party test passed.
New `bunfig.toml` sets `test.pathIgnorePatterns` to exclude `private/`,
`research/`, `work/`, `docs/internal/`, `.swarm/`, and `tmp/`, so the gate now
sees only `src/` and `plugins/` (4588 pass, 10 skip). `private/` is also added
explicitly to oxlint's `ignorePatterns`. No first-party code changed.

Also fixed a flaky assertion in `plugins/memory/cli.test.ts`: the `--limit`
test checked the raw list output with `not.toContain("e1")`, but bullet ids are
base36+hex, so `e1` could land inside a randomly generated id and fail the run
only under full-suite timing. The test now asserts on the body column.

### Feature: oversize images auto-fit instead of being rejected

A 4K screenshot used to bounce with a 400 (`image exceeds 5 MB`). Oversize
images are now downscaled and re-encoded to fit the wire budget before sending:
the long edge is capped at 1568px and a quality/scale ladder brings the encoded
bytes under the cap. New `src/media/transform.ts` (`fitImageToBudget`,
`canTransformImages`, `VISION_LONG_EDGE_PX`). `src/media/limits.ts` now measures
the base64-encoded size (`base64EncodedSize`), the real wire weight, for both
the per-item and per-request caps, and `src/media/resolve.ts` runs the fit pass
(`maybeFit`) and reports what it shrank.

### Feature: native clipboard paste (text and image) on Ctrl+V

`src/media/clipboard.ts` was rebuilt on Bun's native clipboard pipeline
(`Bun.Image.fromClipboard`, plus `clipboardText` / `clipboardImageSync` /
`hasClipboardImage`). The editor (`src/editor-controller.ts`) gained a Ctrl+V
handler that pulls system clipboard text, or a clipboard image routed through
the media interceptor into an `[Image #id]` token, even in terminals where
Cmd+V never reaches the process. When no handler is wired, Ctrl+V inserts no raw
control byte.

### Fix: macOS screenshot paths with Unicode spaces no longer shatter

Dropped or pasted screenshot paths like `Screenshot 2026-05-49.35␏PM.png` carry
a narrow no-break space (U+202F) or no-break space (U+00A0). The media
tokenizer and path detection (`src/media/detect.ts`, `ingest.ts`) now preserve
those code points instead of splitting on them. As a backstop, `src/tools.ts`
self-heals a path whose Unicode space was normalized to a plain space
(`resolveWhitespaceConfusablePath`): Read and Edit resolve the real file instead
of returning ENOENT, and Read notes that it resolved the path.

### Fix: connect-phase network failures retry instead of killing the turn

A failure before the first response byte (TCP connect timeout, ECONNRESET, DNS
EAI_AGAIN, HTTP/2 GOAWAY, "socket hang up") used to stop the agent. New
`src/network/transient-error.ts` classifies these as `network_error` and
`withRetry` (`src/llm/transport/retry.ts`) retries them on the fast curve. User
aborts (Ctrl-C) still propagate untouched. `src/client.ts` also now honors
`x-should-retry: false`, so a deterministic 400 (bad request, oversize image)
propagates at once instead of retry-storming.

### Feature: planning guidance in the system prompt

The `tasks` plugin injects a planning fragment (`prompts/planning.md`) that
tells the model to plan and work in phases with tasks and subtasks. It is
self-gated on `tools.userDefined`, so a model without tool support does not get
the guidance. New `plugins/tasks/handlers/planning_fragment.ts`, wired through a
`promptFragments` entry in the manifest.

### Feature: sub-agent result protocol via a tool, plus context-gated tools

A worker now finishes by calling `ReportResult({summary, artifacts?,
incomplete?})` as its final action. The handler (running in the worker process)
writes the result sentinel deterministically with an atomic temp-then-rename, so
the model never hand-rolls a path or JSON. The completion transport is layered,
best to worst: the `ReportResult` tool call, a manual sentinel write, a
distilled final message, then the `incomplete` floor, so a provider without tool
calling still works. When a worker reports findings but a contracted
`expectArtifacts` file is missing, the supervisor keeps the `incomplete` verdict
but salvages the summary onto the status, so `AgentResult` shows the findings
instead of forcing a transcript dive.

This rides a new general loader feature: a tool handler may export
`available(ctx)` to hide itself from the model's tool list for a turn (and drop
its system-prompt section when its whole tool surface is hidden). Dispatch is
not gated, a hidden tool's handler still runs if invoked, so availability
controls advertisement, not execution. `ReportResult` uses it to stay invisible
to the lead (which has no result path) while workers carry it. New
`plugins/sub-agents/lib/report.ts` + `handlers/report_result.ts`,
`available` plumbing in `src/plugins/loader.ts` and `types.ts`. See
`docs/changes/2026-06-01-subagent-result-protocol-and-tool-availability.md`.

## 2026-06-04

### Fix: sub-agent workers inherit the lead's model (no silent downgrade)

Delegating to a built-in specialist silently ran the worker on a cheaper model:
`explorer` dropped to Haiku, `worker`/`planner`/`integrator` dropped to Sonnet,
even while the lead was on Opus. The model-precedence order in
`plugins/sub-agents/lib/service.ts` put the provider's per-role recommendation
(scout→Haiku, balanced→Sonnet, deep→Opus) AHEAD of the lead's own model, so the
"inherit the lead's model" path was dead for the specialists, which is most
spawns. The downgrade also made `incomplete · no deliverable` outcomes more
likely, since a weaker worker drowns on deep work.

Fix makes the role-recommendation rung opt-in. New `resolveAutoTier` reads
`MINIMAL_AGENT_SUBAGENT_AUTO_TIER`; `makeRecommendForRole` returns undefined
unless it is `1`, so workers now inherit the lead's model by default. Precedence
(default): per-spawn `model` → `MINIMAL_AGENT_SUBAGENT_MODEL` → lead's live model
→ omit `--model`. With `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1` the provider role
recommendation slots back in just below the env override. An explicit per-spawn
model and the env override always win.

Also corrected the model-facing docs that described the cheap default as
intended (`manifest.json` `model` param description, `PROMPT.md`, library/service
comments) and unwrapped the hard-wrapped worker result-protocol template to save
wire tokens. New tests in `runtime.test.ts` and `handler-deps.test.ts`. See
`docs/changes/2026-06-04-subagent-model-inheritance.md`.

## 2026-05-31

### Chore: clear the `bun run check` gate (lint, biome, refactor)

Drove the full gate back to green with zero warnings on the uncommitted feature
drop (sub-agents, schedule, config/usage/model-info plugins, prompt
markdownization, first-run onboarding, usage tracking).

- **oxlint** (1 error + 3 warnings → 0/0): removed an unnecessary template
  expression in `plugins/schedule/lib/box.ts`; replaced a spread-in-`map` with a
  conditional property assign in `PluginLoader.listCommandInfo`
  (`no-map-spread`); classified `src/plugins/loader.ts` into the existing
  `max-lines` override alongside the other large coordinator files.
- **agent.ts back under the line budget by extraction, not exemption.** The
  per-turn attachment / abort-marker / media-ingest / usage-persistence work
  pushed `src/agent.ts` from passing to 820 counted lines. Following the
  documented split pattern, moved `rollbackPendingTurn` and
  `repairOrphanedToolUse` into a new `src/agent/history-repair.ts` (pure
  functions; the `Agent` methods now delegate), with a focused
  `history-repair.test.ts`.
- **biome import-sort**: fixed the `import { abortBus, type AbortReason }`
  ordering in `src/agent/repl-live-area.ts`.
- Gate result: typecheck, lint (0/0), `format:check`, `biome:check`,
  `docs:check`, and `bun test` (4443 pass / 0 fail) all green.

### Fix: opus-4-8 tool-batch hallucination (gate interleaved-thinking off)

opus-4-8 under the `interleaved-thinking-2025-05-14` beta emitted huge parallel
tool batches whose interleaved thinking reasoned about same-turn tool results
that cannot exist yet (every tool in a turn runs after the turn ends), producing
a self-inflicted "results are stalling / batching" spiral and many duplicate
tool calls. Wire-proven against `.net-dbg` captures; absent on opus-4.7 under the
same beta, so it is a model-behavior change (4.7 -> 4.8), NOT the provider
refactor (the harness delivers every tool result correctly). Fix omits the
interleaved-thinking beta for opus-4-8 only (4.6/4.7 + sonnet keep it); escape
hatch `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1`. See
`docs/changes/2026-05-31-fix-opus48-interleaved-thinking-tool-batching.md` and
TODOS.md `T-7c3f02`.

### First-run onboarding: `bunx`-runnable, plugin auto-clone, welcome card

Makes the agent usable on a clean device with no manual install.

- **`bin` field** so it runs through `bunx github:gastonmorixe/minimal-agent`
  (public repos) or `bun add -g "git+https://x-access-token:<TOKEN>@github.com/…"`
  (private). Bun runs the TypeScript source directly: no build step.
- **First-run plugin bootstrap** clones the extended first-party plugins
  (`Fetch`, `Skill`, slash-menu, …) into `~/.minimal-agent/plugins` once. The
  loader gained a fourth root, `user`, with precedence
  `project > home > user > embedded`.
- **Token-aware + safe:** resolves `MINIMAL_AGENT_GITHUB_TOKEN` →
  `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`, injected via an inline git
  credential helper so the token never reaches argv, the clone URL, or the
  cloned `.git/config`. Best-effort: no git / offline / no token degrades to
  the embedded plugins, never crashes.
- **Welcome card** on a cold interactive start frames the one-time setup
  (sign in, fetch mdstream, fetch plugins).
- Controls: `MINIMAL_AGENT_NO_PLUGIN_SYNC=1`, `MINIMAL_AGENT_PLUGINS_REPO`,
  config `pluginSync` / `pluginsRepo`. Verified end-to-end in a clean
  `oven/bun:1.3-debian` container.

See `docs/changes/2026-05-31-first-run-onboarding.md`.

### Schedule plugin: TUI redesign + sub-minute intervals

- **New icons.** Replaced the `⏰` color-emoji (which ignored color) and the
  faint `◷` with monochrome, SGR-colorable glyphs: `⧗` (a point in time /
  one-shot) and `⟳` (a recurring loop). Tool-header icons now render bold so
  thin glyphs read at terminal size.
- **Colored boxed output.** `/loop` and `/schedule` confirmations, and the
  `Cron*` tool results, render in the same rounded `╭─ │ ╰─` box the host draws
  around tool calls (header glyph + cadence + timestamp, prompt in the body,
  id + expiry + cancel hint in the footer).
- **Width-aware live-bar footer.** Leads with the soonest task (`⧗` + short id +
  countdown), then lists the other task ids with a `+K` overflow marker;
  degrades to `⧗ next in 26s · N tasks`, then `⧗ N tasks`, then bare `⧗` as the
  terminal narrows. Glyph is gold normally, lime when the soonest task is due
  within a minute.
- **Sub-minute intervals fixed.** `/loop 10s` (and `CronCreate every:"10s"`) no
  longer round up to 1 minute. Cron is minute-granular, so sub-minute cadences
  now run on the dynamic pace with a new `CronEntry.intervalMs` that re-arms
  after each fire (floored at 1s). With the 1-second heartbeat a `10s` loop
  fires about every 10 seconds (a fire still waits for any in-flight turn).
- Model-facing tool-result `content` stays plain text; all color lives in the
  TUI-only surfaces.

## 2026-05-30

### Schedule plugin (`/loop`, `/schedule`, `Cron*` tools)

Run prompts on a schedule, ported from Claude Code's scheduled tasks.

- **Three tools** (`CronCreate`, `CronList`, `CronDelete`) the model drives from
  natural language ("remind me at 3pm", "every 5 minutes check the deploy").
- **Two commands** (`/loop`, `/schedule`) for direct user control.
- **1-second heartbeat** that injects due prompts between turns.
- Tasks persist at `~/.minimal-agent/sessions/<sid>.cron.json` and restore on
  `--resume` (unexpired tasks only).
- Disable with `MINIMAL_AGENT_DISABLE_CRON=1`.

See `docs/changes/2026-05-30-schedule-plugin.md`.

### Sub-agents plugin

Delegate work to background `minimal-agent` workers (`SpawnAgent` and friends),
watch them in a live fleet widget, and fold their distilled results back. Built
on generic seams; the core agent loop never learns the word "sub-agent". Disable
with `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.

See `docs/changes/2026-05-30-sub-agents.md`.

### Prompts as markdown

Plugin system-prompt fragments and tool descriptions move to markdown, composed
under role-typed `<ma::sys::*>` wrappers.

See `docs/changes/2026-05-30-prompts-as-markdown.md`.

### Tool routing + search directives

See `docs/changes/2026-05-30-tool-routing-search-directives.md`.
