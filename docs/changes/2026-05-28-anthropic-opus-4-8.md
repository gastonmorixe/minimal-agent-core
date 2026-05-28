# Anthropic Opus 4.8 support + LLM provider abstraction core

**Status:** shipped (Phase 4 closed; Phases 6 OpenAI / agent-loop canonicalization deferred)
**Owner:** agent (session 4efe61e0)
**Scope:** `src/llm/` (new), `src/headers.ts`, `src/client.ts`, `src/client/types.ts`, `src/agent.ts`, `src/index.ts`, `src/effort-resolution.ts`, `src/client.test.ts`, `src/headers.test.ts`

## What shipped

### Opus 4.8 (and 4.7 / 4.6 catch-up)

- **Model id `claude-opus-4-8` is registered** in the new canonical model registry with full capabilities: 1M context, 128K max output, adaptive-only thinking, `effort: low|medium|high|xhigh|max`, fast-mode capable, mid-conversation system messages, 1h prompt cache, server-side `web_search` + `code_interpreter`, knowledge cutoff Jan 2026.
- **`[1m]` alias synthesized** for opus-4-8 (`claude-opus-4-8[1m]`) so `--list-models` shows it alongside opus-4-6[1m] / opus-4-7[1m] / sonnet-4-6[1m].
- **Default pricing $5 / $25 per MTok**; `pricingForRequest()` switches to `$10 / $50` (the `cx1` rate) when `speed: "fast"` is set. Verified against `cli.patched.cjs` v2.1.154 L116494-L116580.

### New wire-format support (the six new betas)

Added to `src/headers.ts` `BetaFlagId` enum and the `buildBetaFlags()` conversation-flag assembler:

- `mid-conversation-system-2026-04-07` — accept `role:"system"` entries inside `messages[]`. Used by claude-code for user-interrupt notifications, tool-availability nudges, task-list reminders.
- `extended-cache-ttl-2025-04-11` — allows `cache_control.ttl: "1h"` on prompt-cache breakpoints. Default 5m otherwise.
- `thinking-token-count-2026-05-13` — surfaces `output_tokens_details.thinking_tokens` on `message_delta`.
- `fast-mode-2026-02-01` — opt-in via `speed: "fast"` on the request body. Gated; not all subscriptions include the metered tier.
- `task-budgets-2026-03-13` — `output_config.task_budget` lets the model see a running token countdown and self-moderate.
- `cache-diagnosis-2026-04-07` — top-level `diagnostics: { previous_message_id }` block for prompt-cache debugging.

### CLI surfaces

- **`--fast`** (and `MINIMAL_AGENT_FAST=1`): forwards `speed: "fast"` to the wire + adds the fast-mode beta header.
- **`--effort xhigh`** now accepted alongside `low|medium|high|max` (matches what opus 4.7 / 4.8 / Sonnet 4.6 advertise).
- **`Agent.pushSystemMessage(text)`** helper: appends a `role:"system"` message to `messages[]` for mid-conversation operator nudges. Mirrors claude-code's three concrete use cases.
- **`StreamedResponse.stopDetails`** is now populated when the server categorizes the stop (e.g. refusal). Host UI can route on the opaque `type` string without parsing prose.
- **Startup `/api/claude_cli/bootstrap` probe** (OAuth only): fires after auth resolves, applies `additional_model_costs` overlay to the registry. Silently absorbs failures.

### Version constants

| Constant | Was | Now |
| --- | --- | --- |
| `VERSION` | `2.1.118` | `2.1.154` |
| `STAINLESS_SDK_VERSION` | `0.81.0` | `0.94.0` |
| `BUILD_HASH` | `3a7` | `d6e` |
| `BUILD_TIME` | `2026-04-25T00:00:00Z` | `2026-05-28T12:27:24Z` |
| `GIT_SHA` (new) | — | `b84d2da9ada13121515426fc644786a303e9ac53` |

Sourced from `cli.patched.cjs` v2.1.154 L166-L212 and verified against the live `.node-net-dbg/1779992683022-28-MAY-2026-THURSDAY-…` capture.

### Verification

- **38 new unit tests** under `src/llm/` (canonical core + Anthropic adapter) — all green.
- **11 new Opus-4.8-specific tests** under `src/llm/providers/anthropic/opus-48-features.test.ts` covering fast-mode pricing, task-budget wire, mid-conv system, cache diagnostics, refusal `stop_details`, thinking-token surfacing, cache TTL breakdown.
- **2 new E2E live smoke tests** under `src/client.test.ts > e2e` (require `E2E=1`):
  - Standard Opus 4.8 round-trip with adaptive thinking + effort=high — PASSES.
  - Opus 4.8 with `--fast` — accepts either 200 OK OR 429 `"Usage credits are required for fast mode"` as proof that `speed:"fast"` + `fast-mode-2026-02-01` beta reached the server correctly. PASSES (the user's Claude Max subscription doesn't include the metered fast-mode tier; the wire shape is correct).
- **Whole suite: 3381 / 3381 pass** after the changes; 7 skipped (live-network gated).

## The new LLM provider abstraction core (`src/llm/`)

Built as the **foundation** for adding OpenAI / OpenAI Responses / future providers without touching the agent loop. The canonical layer + Anthropic adapter are landed and tested; OpenAI is **deferred** to a separate session (see "Deferred work" below).

```
src/llm/
├── canonical-events.ts       CanonicalEvent union (MessageStart, TextDelta, ThinkingDelta,
│                             ToolUseStart/InputDelta/Stop, MessageDelta with StopDetails,
│                             RefusalDelta, StreamError, Ping)
├── canonical-messages.ts     CanonicalRole, CanonicalBlock (text|thinking|tool_use|tool_result|
│                             image|audio|file), userText/systemMessage/toolResult helpers
├── canonical-request.ts      CanonicalRequest with system/messages/tools/effort/thinking/
│                             speed/outputFormat/metadata, AnthropicVendorOpts + OpenAIVendorOpts
│                             escape hatches
├── canonical-tools.ts        CanonicalToolDefinition, ToolChoice
├── capabilities.ts           Capabilities record + helpers (compareEffort, supportsEffort, …)
├── pricing.ts                MTokRate, calculateUsageCost, mergeUsage, known rate tables
│                             (ANTHROPIC_OPUS_4X_STANDARD, OPUS_48_FAST, OPUS_4X_FAST_LEGACY,
│                             SONNET_STANDARD, HAIKU_45, …)
├── errors.ts                 ProviderError hierarchy + CapabilityViolation +
│                             UnsupportedCapabilityError (with optional `degrade` fallback)
├── model-registry.ts         registerModel / resolveModel / findModel / listRegisteredModels
│                             + provider registry. Singleton with explicit-clear for tests.
├── provider.ts               ProviderAdapter port: validate(req, model) → ValidationResult,
│                             run(req, model, ctx) → AsyncIterable<CanonicalEvent>
├── run.ts                    Top-level run() — dispatches by model → provider, validates,
│                             optional `acceptDegrade`
├── adapter-legacy.ts         Legacy ↔ canonical bridge: canonicalToSendOptions(),
│                             streamedResponseToCanonicalEvents(), runLegacyAsCanonical()
├── streaming/sse-parser.ts   Generic line-buffered SSE parser
├── providers/anthropic/      Full Anthropic Messages adapter:
│   ├── adapter.ts            implements ProviderAdapter; bootstrapAnthropic() registers
│   ├── beta-flags.ts         All 25 ANTHROPIC_BETA_FLAGS + classifyRequest +
│   │                         buildBetaFlags() (rule-by-rule live-capture parity)
│   ├── bootstrap.ts          fetchBootstrap() + applyBootstrapOverrides()
│   ├── capabilities.ts       CAPS_OPUS_48/47/46, SONNET_46/45, HAIKU_45
│   ├── headers.ts            buildAnthropicHeaders (Stainless + OAuth + per-request UUID)
│   ├── models.ts             registerAnthropicModels() — 6 models with pricingForRequest
│   ├── request-body.ts       Canonical → wire (model, system blocks with cache_control,
│   │                         tools, metadata.user_id JSON-packed, thinking adaptive/extended,
│   │                         context_management default, output_config, speed, diagnostics)
│   ├── response-stream.ts    Anthropic SSE → CanonicalEvent (tool_use input JSON
│   │                         accumulation, stop_details surfacing, refusal/overloaded
│   │                         error categorization, cache_creation 5m/1h breakdown,
│   │                         output_tokens_details.thinking_tokens → reasoningTokens)
│   ├── validate.ts           Capability gating (sampling, thinking modes, effort levels,
│   │                         mid-conv system, speed, structured outputs, [1m] alias,
│   │                         assistant prefill, previousResponseId)
│   ├── wire-constants.ts     URLs + version re-exports
│   ├── index.ts              Public surface
│   ├── __fixtures__/         Live 2026-05-28 captures (quota / title / opus48)
│   ├── anthropic.test.ts     27 tests
│   └── opus-48-features.test.ts  11 tests (4.8-specific)
└── providers/openai/         **STUB** — Phase 6 foundation files written but not registered.
                              See "Deferred work" below.
```

### Patterns applied

From the `software-best-design-patterns` skill:

- **Strategy** — `ProviderAdapter` lets the dispatch site (`run()`) pick the implementation by model registry lookup, no branching.
- **Adapter** — `adapter-legacy.ts` translates legacy `SendOptions` / `StreamedResponse` to canonical shapes, both directions. Lets the legacy client.ts and new canonical layer coexist.
- **Registry** — `model-registry.ts` and the provider registry are module-singletons with explicit `clearModelRegistry()` / `clearProviderRegistry()` for test isolation.
- **Discriminated Union State** — `CanonicalEvent` uses `type` discriminator for exhaustive switch coverage.
- **Result type** — `ValidationResult { ok, errors, degrade? }` lets the caller distinguish hard rejection from "ok but here's a degraded alternative".
- **Hexagonal/Ports-and-Adapters** — the canonical types are the "core"; provider adapters are the ports facing the wire.

## Architecture decisions

### Why the canonical layer runs ALONGSIDE the legacy `client.ts`, not REPLACING it

The legacy `src/client.ts` carries ~1500 lines of carefully tuned cross-cutting infrastructure: stream-idle watchdog, hard-timeout watchdog, retry coordinator with overloaded/api/invalid-request categorization, 401 keychain-first refresh (multi-process race fix), network activity observer, cache anomaly detector, status-bus updates, rate-limit broadcaster. Rewriting that against the canonical layer is high-risk for the actual goal at hand (shipping 4.8). The two paths coexist:

- **Today**: `Agent.send` / `Agent.run` use the legacy `sendMessage` (untouched, all features work).
- **Today**: New canonical code (`run()` from `src/llm/`) talks directly to the Anthropic native adapter. Useful for the OpenAI adapter when it lands.
- **Tomorrow**: Phase 4-extended migration will swap Agent's transport to canonical, moving the watchdog/retry/observer to provider-neutral middleware.

This way the abstraction is in place + tested for OpenAI without disrupting the 3300+ Anthropic test cases.

### Why we DON'T strictly validate `--model` against the registry

The CLI accepts arbitrary model strings (`--model anything`) and the server is the source of truth on what's accepted. Strict client-side validation would prevent passing forward-compat model ids (e.g. `claude-opus-4-9` when it ships before our registry updates). The registry IS used for `--list-models` enrichment and pricing display, but not as a gate.

### Why the cost-display side is not in this PR

The pricing DATA is correct and tested (`opus-48-features.test.ts` verifies `pricingForRequest` doubles base when `speed:fast`). The DISPLAY layer (a `$0.42` segment in the live-area footer) is a separate UI feature — no existing cost-display lives in `live-area-providers.ts` to wire into. Added to the Phase 7 backlog as a UI enhancement.

## Deferred work (tracked, not done today)

### Phase 6 — OpenAI provider skeleton

Foundation files are written under `src/llm/providers/openai/` (capabilities, headers, wire-constants, pricing, chat/{request-body,response-stream}, responses/{request-body,response-stream}) but not registered. Live SSE captures saved under `src/llm/providers/openai/__fixtures__/` (chat-pong, chat-tool-use, chat-structured-output, chat-vision, responses-pong, responses-reasoning, responses-tool-use, responses-vision, responses-structured + responses-reasoning-high). Resume guidance in `private/research/2026-05-28-llm-providers/04-codex-cli-research.md` — points at the OpenAI codex-cli source's `models.json` as the canonical capability registry to mirror.

### Phase 4-extended — agent loop canonicalization

`Agent.send` / `Agent.run` keep using `client.sendMessage` today. Switching to `run()` from `src/llm/` requires moving the legacy transport infrastructure (watchdog, retry, 401 refresh, observer, status bus) into provider-neutral middleware layers. Risky and orthogonal to "ship 4.8". Tracked as a separate task.

### UI enhancements

- Cost-per-turn segment in the live-area footer (data is ready via `calculateUsageCost(usage, model.pricingForRequest?.(req) ?? model.pricing)`).
- REPL surfacing of `stopDetails.type` when a turn ends in refusal (data flows; UI side missing).

## Research artifacts

All design + capture work lives under `private/research/2026-05-28-llm-providers/`:

- `00-research-notes.md` — Everything decoded from claude-code 2.1.154 source, live network capture, embedded official Anthropic skill. Beta flags, pricing, capability gates, request body shape, response stream additions, mid-conversation system messages in practice. OpenAI APIs context (Chat / Responses / Realtime).
- `01-architecture.md` — Canonical-types-first design. File layout. `Capabilities`, `CanonicalMessage`, `CanonicalRequest`, `CanonicalEvent`, `ProviderAdapter` port, `run()` orchestrator. Phase plan, error model, vendor escape hatches.
- `02-wire-snapshots.md` — Header + body snapshots for Anthropic carve-out parity + the Opus 4.8 wiring.
- `03-openai-mapping.md` — Chat Completions and Responses wire formats, the per-surface request body, the SSE event-to-canonical mapping, capability table per surface, Realtime deferral.
- `04-codex-cli-research.md` — Resume guidance for the OpenAI phase: which files in `~/Projects/codex-cli-sourcecode/` are the canonical reference, plus pointers to the live codex session JSONL the user recorded.

## Files touched

```
A  private/research/2026-05-28-llm-providers/00-research-notes.md       (273 lines)
A  private/research/2026-05-28-llm-providers/01-architecture.md         (333 lines)
A  private/research/2026-05-28-llm-providers/02-wire-snapshots.md       (217 lines)
A  private/research/2026-05-28-llm-providers/03-openai-mapping.md       (343 lines)
A  private/research/2026-05-28-llm-providers/04-codex-cli-research.md   (78 lines)
A  private/research/2026-05-28-llm-providers/README.md                  (22 lines)

A  src/llm/                                                             (12 files, ~1800 LoC)
A  src/llm/providers/anthropic/                                         (12 files + fixtures)
A  src/llm/providers/anthropic/__fixtures__/                            (7 files, live capture)
A  src/llm/providers/openai/                                            (Phase 6 stubs)
A  src/llm/providers/openai/__fixtures__/                               (live captures)
A  src/llm/streaming/sse-parser.ts

M  src/headers.ts                  VERSION 2.1.118→2.1.154, Stainless 0.81→0.94, BUILD_HASH,
                                   GIT_SHA, 6 new BetaFlagId entries, buildBetaFlags() adds
                                   mid-conv-system + extended-cache-ttl unconditionally and
                                   fast-mode/task-budgets/cache-diagnosis on opt-in
M  src/client.ts                   speed: "fast" body field, stopDetails capture from
                                   message_delta, supports1M now includes opus-4-8
M  src/client/types.ts             SendOptions.speed, StreamedResponse.stopDetails,
                                   Message.role widened to include "system"
M  src/agent.ts                    Agent.speed (constructor + thread to sendFn 3 sites),
                                   Agent.pushSystemMessage(text) helper
M  src/index.ts                    bootstrapAnthropic() at module load, --fast CLI flag,
                                   /api/claude_cli/bootstrap probe after auth, --help text
M  src/effort-resolution.ts        KNOWN_EFFORT includes "xhigh"
M  src/headers.test.ts             updated pinned beta-flag ordering for new flags
M  src/client.test.ts              cc_version bumped, 2 new E2E smokes for opus-4-8
```
