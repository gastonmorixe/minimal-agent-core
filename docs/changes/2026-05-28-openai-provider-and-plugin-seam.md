# OpenAI provider + provider-plugin seam + footer tag

**Status:** shipped (canonical OpenAI provider + ProviderPlugin contract + footer tag + physical extraction into `plugins/llm-anthropic` / `plugins/llm-openai` with a discovery loader).
**Owner:** agent (session continuing 4efe61e0)
**Builds on:** [`2026-05-28-anthropic-opus-4-8.md`](./2026-05-28-anthropic-opus-4-8.md) (the canonical core + Anthropic adapter + Opus 4.8).

This session continued the LLM-provider work: cleared the lint backlog, documented the layer, added the OpenAI provider through the canonical layer, introduced a provider-plugin contract, and reworked the footer's effort segment into a provider-model tag.

## What shipped (6 commits on `dev-private`)

### 1. Lint backlog cleared + exhaustive-switch convention

The 72 lint errors in `src/llm/` are gone and `bun run check` is fully green (typecheck + oxlint + biome format/import-sort + typedoc + 3416 tests).

- 56 `eslint-plugin-jsdoc(require-yields)`: one `@yields` tag added per stream generator (5 functions; the rule fires once per `yield`, so a single tag clears the cluster).
- 7 `consistent-return`: exhaustive discriminated-union switches now end with the compile-time `const _exhaustive: never = x; throw ...` check (matches `src/cli/command-plan.ts`), so adding a union member fails `tsc` at the switch rather than silently at runtime.
- 4 `no-redundant-type-constituents` (`keyof Capabilities | (string & {})`, `unknown`, literal-union `& {}`), 2 `no-unnecessary-type-conversion` (dropped `String()` wraps), 1 `check-tag-names` (`@typeParam` → `@template`), 1 unused import, 1 single-use type parameter.
- `biome:check` (import-sort) was never run against the new files by the prior session; applied tree-wide.

### 2. Docs (README + CLAUDE.md)

- **README**: a Models table (opus-4-8 / opus-4-7 / sonnet-4-6 / haiku-4-5 with context, max output, effort levels, fast, pricing), `--fast` / `MINIMAL_AGENT_FAST`, `--effort xhigh`, and `MINIMAL_AGENT_MODEL` / `_FAST` in the environment list.
- **CLAUDE.md** (new): agent orientation including the build/lint gate, the exhaustive-switch convention, and a "How the LLM layer is structured" section pointing at `private/research/2026-05-28-llm-providers/01-architecture.md`.

### 3. OpenAI provider (Chat Completions + Responses)

The foundation stubs are now a registered, tested provider on the canonical layer.

- One `ProviderAdapter` (`id: "openai"`), two surfaces; `adapter.run()` dispatches by `ModelEntry.surfaceId`: `openai-chat` → `/v1/chat/completions`, `openai-responses` → `/v1/responses`.
- `models.ts` registers gpt-5.5 (+ `gpt-5.5-chat`), gpt-5, o3, o4-mini (Responses) and gpt-4.1, gpt-4o, gpt-4o-mini (Chat). **Dual-surface models register twice** under distinct ids; `vendorIds.firstParty` carries the real `gpt-5.5` id on the wire.
- **GPT-5.5 capabilities + pricing**: 1,050,000 context, 128K max output, effort `low|medium|high|xhigh`, $5 in / $30 out per MTok (NOT $5/$25), cached $0.50, knowledge cutoff 2025-12 (developers.openai.com/api/docs/models/gpt-5.5). The codex `models.json` slug `gpt-5.5` grounded the rest (reasoning levels, modalities).
- `validate.ts` mirrors the Anthropic capability gating (effort levels, thinking visibility, `speed:"fast"`, structured outputs, and `previousResponseId` allowed only on the Responses surface).
- The generic SSE parser already tolerates OpenAI's per-chunk `obfuscation` padding (BREACH mitigation) and the Responses API's `event:` lines.
- 16 tests replay the live SSE fixtures (chat + responses: pong, tool-use, vision, structured-output, reasoning/-high) through the translators and assert canonical events + usage (incl. `reasoningTokens`).
- `bootstrapOpenAI()` is registered at startup. Registration is **pure** (no network): the agent loop still transports Anthropic via the legacy `client.ts`; the OpenAI catalog is reachable through the canonical `run()` and the registry (full agent-transport routing needs the deferred "Phase 4-extended" agent canonicalization).

### 4. Provider-plugin seam (the start of "providers as plugins")

- `src/llm/provider-plugin.ts`: a `ProviderPlugin` contract (`id` / `displayName` / `shortCode` / idempotent `register()`) plus a registry.
- Anthropic and OpenAI each export their `ProviderPlugin`; `src/llm/providers/index.ts` lists the built-ins and exposes `activateBuiltinProviders()`.
- `src/index.ts` no longer names a provider for registration: it calls `activateBuiltinProviders()` instead of `bootstrapAnthropic()` + `bootstrapOpenAI()`. The agent loop (`src/agent.ts`) was already provider-agnostic; this removes the last provider names from the composition root's registration path. This is the exact contract a future `plugins/llm-<id>/` package will export.

### 5. Footer: provider-model tag

The quota-status footer's trailing segment now reads `<tag>:<level>` (e.g. `anth-4.8:max`, `oai-5.5:high`): the provider-model short tag bold/bright, the effort level faint, a minimalist colon between, dropping the literal "effort" word. New `modelShortLabel(modelId)` in `src/llm` derives the tag from the `ProviderPlugin.shortCode` + a version token, with a prefix fallback for unregistered ids. Backward-compatible (no `modelLabel` → legacy `effort <level>`); narrow/compressed forms still drop the tag first.

## Verification

`bun run check` green throughout. Test count: 3392 → **3416 pass / 9 skip / 0 fail** (+16 OpenAI, +3 provider-plugin, +5 model-label/footer). The legacy `src/client.ts` retry/watchdog/observer/401-refresh infrastructure was not touched.

## Shipped: physical plugin extraction (`plugins/llm-*`)

The providers now live as plugins and the core imports no provider by name (5 more commits, each green):

1. **Move** (`git mv`, history preserved): `src/llm/providers/anthropic` → `plugins/llm-anthropic/`, `src/llm/providers/openai` → `plugins/llm-openai/`. Imports to the canonical core rewritten to `../../src/llm/*` (and `../../../src/llm/*` from the OpenAI `chat/`+`responses/` subdirs), including inline `import()` forms and `src/headers.ts` / `src/network`. Tests + fixtures moved with their code.
2. **Descriptor**: each plugin ships a `provider.json` (`id` / `entry` / `export`), kept SEPARATE from the TUI `manifest.json` so the late async `PluginLoader` never touches providers (and no plugin-count surprises).
3. **Discovery loader** (`src/llm/provider-discovery.ts`): scans a plugins dir for `provider.json`, dynamically imports each declared `ProviderPlugin` (path absolutized via `resolve`, since a bare relative path in `import()` resolves against the module, not cwd), and registers it. A dedicated EARLY loader, deliberately separate from the TUI `PluginLoader` (which runs too late for startup model resolution).
4. **Wired**: `main()` calls `registerDiscoveredProviders(<repo>/plugins)` + `activateProviderPlugins()` before the bootstrap probe / footer / canonical `run()` read the registry. The static builtin barrel (`src/llm/providers/index.ts`) is deleted; `src/index.ts` imports zero provider code by name.
5. **Cross-plugin reuse**: a future `plugins/llm-<groq|azure|together>/` can import `plugins/llm-openai`'s translators/request-body (same wire spec, different endpoint + capabilities) and ship its own `provider.json` + `ProviderPlugin`.

## Follow-ups (same session)

- **Multimodality gating + tests.** A shared `modalityViolations()` (`src/llm/modality-check.ts`) makes Anthropic + OpenAI reject image/audio/file inputs the model doesn't accept (a `CapabilityViolation` instead of a silent drop). Tests cover gating (Opus accepts image + PDF / rejects audio; Haiku rejects PDF; gpt-4o accepts audio / gpt-4o-mini rejects) and the request-encoding wire shapes across all three surfaces.
- **OpenRouter provider** (`plugins/llm-openrouter`) — the cross-plugin-reuse example. It is OpenAI Chat-compatible, so it reuses `llm-openai`'s request body + SSE translator + headers + validator wholesale; only the endpoint (`openrouter.ai/api/v1`) + catalog differ. Runtime auth uses minimal-agent's provider auth store. Offline tests pass; a live `gpt-4o-mini` round-trip is gated on `MINIMAL_AGENT_OPENROUTER_LIVE_KEY`.
- **`--list-models` fix + `providers` CLI grammar.** `--list-models` now merges the canonical registry (it only showed Anthropic before). New `providers` / `providers models [id]` subcommands list registered providers and (optionally filtered) models; `--list-models` / `--models` kept as a deprecated alias.

Final state: `bun run check` green, **3436 pass / 10 skip / 0 fail**; three providers auto-discovered (anthropic, openai, openrouter).

Note: a model selected via `--model` still runs through the legacy Anthropic transport in the agent loop; making `--model gpt-5.5` actually dispatch to OpenAI at runtime is the separate "Phase 4-extended" agent-canonicalization epic and intentionally out of scope here.
