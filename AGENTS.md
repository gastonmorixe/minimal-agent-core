# CLAUDE.md

Orientation for agents working in this repo. User-facing usage lives in
[`README.md`](README.md); deferred work in [`TODOS.md`](TODOS.md); per-change
write-ups in [`docs/changes/`](docs/changes/); deeper design notes and reverse
-engineering captures under `private/research/`.

## Build, test, lint

- `bun run check` is the one gate that must stay green. It runs, in order:
  typecheck, lint (oxlint), `format:check`, `biome:check` (format + import
  sort), `docs:check` (typedoc), then `bun test`. It stops at the first
  failure.
- `bun test` runs the suite (currently 3392 pass / 9 skip; the skips are live
  -network E2E behind `E2E=1`).
- Lint is `oxlint` (config in `.oxlintrc.json`). Biome owns formatting and
  import-sort only; its linter is off. `bun run format` does NOT sort imports,
  so run `bun run biome:fix` (or `bun run check`) before assuming a tree is
  clean.

## Conventions worth knowing

- **Exhaustive switches over discriminated unions** end with a compile-time
  check, not a bare `throw`:
  ```ts
  default: {
    const _exhaustive: never = value
    throw new Error(`unhandled ...: ${_exhaustive}`)
  }
  ```
  If someone adds a union member, tsc fails at the switch instead of at
  runtime. See `src/cli/command-plan.ts` and `src/client/debug.ts` for the
  pattern.
- **Generators carry a JSDoc `@yields`** (oxlint's jsdoc `require-yields` is on).
- **Capabilities are data, not branching.** Code asks "does this model support
  X?" by reading a `Capabilities` record, never "is this opus-4-7?".
- **Prompts live in markdown, not string literals.** Every model-facing prompt
  (system prompt, tool descriptions, sub-prompts) is a `.md`/`.tmpl.md` file
  loaded through [`src/prompts.ts`](src/prompts.ts). Core prompts are under
  [`src/prompts/`](src/prompts/README.md); plugin prompts sit next to the plugin
  (`PROMPT.md`, or `plugins/<id>/prompts/*`). Templates use `%%name%%` (required,
  throws if unwired) and `%%name?%%` (optional). The rule: prose in markdown,
  control flow (which fragment, what order) in TypeScript. See
  `buildLoopSafetyParagraph` in `src/headers.ts` for the worked example, and
  `docs/changes/2026-05-30-prompts-as-markdown.md` for the rationale.

## How the LLM layer is structured

The provider abstraction lives under [`src/llm/`](src/llm/). It exists so the
agent loop, REPL, and live-area renderers depend on canonical types, never on a
specific vendor's wire format. Anthropic is the first (and currently only wired)
adapter; OpenAI Chat + Responses foundation files are present but not registered.

Full design rationale, the capability schema, and the phase plan are in
[`private/research/2026-05-28-llm-providers/01-architecture.md`](private/research/2026-05-28-llm-providers/01-architecture.md).
The shipped state and gotchas are in
[`docs/changes/2026-05-28-anthropic-opus-4-8.md`](docs/changes/2026-05-28-anthropic-opus-4-8.md).

### The canonical core (`src/llm/`)

Vendor-neutral types and the orchestrator. Import everything from the barrel
`src/llm/index.ts`.

- `canonical-request.ts` / `canonical-messages.ts` / `canonical-tools.ts` :
  what the agent sends. `CanonicalRequest` carries `system`, `messages`,
  `tools`, `effort`, `thinking`, `speed`, `outputFormat`, `metadata`, plus
  per-vendor escape hatches (`vendor.anthropic`, `vendor.openai`).
- `canonical-events.ts` : `CanonicalEvent`, one discriminated union every
  provider's stream parses INTO (`message_start`, `text_delta`,
  `thinking_delta`, `tool_use_*`, `message_delta` with `stopDetails`,
  `stream_error`, ...). The wire-event names never leave the adapter.
- `capabilities.ts` : the `Capabilities` record (context window, thinking
  modes, effort levels, caching, tools, modalities, speed, server tools).
- `model-registry.ts` : `registerModel` / `resolveModel` / `findModel` plus the
  provider registry. Module singletons with `clearModelRegistry()` /
  `clearProviderRegistry()` for test isolation.
- `provider.ts` : the `ProviderAdapter` port :
  `{ id, surfaces, validate(req, model), run(req, model, ctx) }`.
- `run.ts` : `run(req, { context, acceptDegrade? }): AsyncIterable<CanonicalEvent>`.
  Resolves model → provider, validates, then delegates to the adapter. With
  `acceptDegrade`, a validation failure that offers `degrade` is retried with
  the fallback request instead of throwing.
- `errors.ts` : the provider-neutral error hierarchy (`ProviderError`,
  `CapabilityViolation`, `UnsupportedCapabilityError`, stream timeout/auth).
- `pricing.ts` : `MTokRate`, `calculateUsageCost`, `mergeUsage`, and the known
  Anthropic rate tables.
- `streaming/sse-parser.ts` : a generic line-buffered SSE parser the adapters
  reuse.

### Provider plugins (`plugins/llm-<id>/`)

Each provider is a PLUGIN under `plugins/llm-<id>/`, not part of the core. A
plugin ships a `provider.json` descriptor (`id` / `entry` / `export`) and
exports a `ProviderPlugin` (`id` / `displayName` / `shortCode` / `register()`).
Inside, the adapter is the only place that knows a wire format. Shape:
`validate.ts` (capability gating), `request-body.ts` (canonical → wire),
`response-stream.ts` (wire SSE → `CanonicalEvent`), `capabilities.ts` +
`models.ts` (registry data), `headers.ts`, `adapter.ts` (implements the port +
`bootstrap<Provider>()` + the exported `ProviderPlugin`). Canonical-core imports
use `../../src/llm/*`.

- `plugins/llm-anthropic/` is complete: 6 models, full Messages mapping, live
  SSE fixtures, 38 tests.
- `plugins/llm-openai/` is complete: Chat + Responses surfaces, gpt-5.x / gpt-4 /
  o-series (gpt-5.5 registered dual-surface), live SSE fixtures, 16 tests.

`src/llm/provider-discovery.ts` is the EARLY provider loader: it scans
`plugins/llm-*` for `provider.json`, dynamically imports each `ProviderPlugin`,
and registers it. `main()` calls `registerDiscoveredProviders(<repo>/plugins)`
then `activateProviderPlugins()` BEFORE any model resolution, so `src/index.ts`
names no provider. This is separate from the TUI `PluginLoader` (which runs
later for tools / live-area slots; provider registration must happen earlier).

### Coexistence with the legacy client (important)

The new canonical layer runs ALONGSIDE the legacy `src/client.ts`, it does not
replace it. `Agent.send` / `Agent.run` still call `client.sendMessage`, which
carries ~1500 lines of tuned cross-cutting infrastructure (idle/hard-timeout
watchdogs, retry coordinator, 401 keychain-first refresh with a multi-process
race fix, network observer, status bus). For Anthropic both paths emit identical
bytes.

`src/llm/adapter-legacy.ts` bridges the two directions (`canonicalToSendOptions`,
`streamedResponseToCanonicalEvents`, `runLegacyAsCanonical`). Migrating the
agent loop onto `run()` (and moving the transport infrastructure into
provider-neutral middleware) is "Phase 4-extended", a separate epic. **Do not
refactor the `client.ts` watchdog/retry/observer/401-refresh code as a
side-effect of provider work.**

### Adding a model or provider

- New model for an existing provider: add a `Capabilities` record in that
  plugin's `capabilities.ts` and a `registerModel({...})` entry in its
  `models.ts` (e.g. under `plugins/llm-anthropic/`).
- New provider: create `plugins/llm-<id>/` mirroring an existing one, implement
  the `ProviderAdapter` port + a `bootstrap<Id>()`, export a `ProviderPlugin`,
  and add a `provider.json` pointing at it. Discovery registers it at startup.
  A provider that reuses another's wire spec (e.g. an OpenAI-compatible gateway)
  can import that plugin's translators/request-body (see `plugins/llm-openrouter`,
  an OpenAI-compatible gateway that reuses `llm-openai`'s wire layer). The CLI
  does not validate
  `--model` against the registry (the server is the source of truth), so
  forward-compat ids pass through.

## Slash commands + scheduling (the `commands[]` port)

Plugins contribute slash commands declaratively via a manifest `commands[]`
array (`{name, summary, argHint?, handler}`), mirroring `tuis`/`modes`/
`liveAreaSlots`. The loader collects them into a host-owned registry
(`getCommands` / `hasCommand` / `listCommandInfo` / `dispatchCommand`,
first-wins on cross-plugin name collision). `runReplLiveArea.onSubmit`
intercepts a registered `/<name>` (parsed by the pure `src/slash-command-parse.ts`)
and acts on the handler's `CommandResult` union (`expand` → model turn,
`notice`/`error` → scrollback, `none` → nothing). Commands work headlessly; the
`slash-menu` plugin is just an autocomplete overlay over the registry (it reads
`ctx.listCommands()`, injected into hook/event contexts).

Out-of-band prompt injection rides the `prompt.inject` bus channel
(`{text, source?}`): the REPL turns it into a normal queued submit that fires
BETWEEN turns. The live-area handler context gained `emit` so a periodic slot can
use it. The `schedule` plugin (cron engine + `CronCreate/List/Delete` + `/loop`
+ `/schedule` + a 1s heartbeat) is built entirely on these ports — it imports no
harness runtime, only `import type` from `src/plugins/types.ts`. See
`docs/changes/2026-05-30-schedule-plugin.md`.
