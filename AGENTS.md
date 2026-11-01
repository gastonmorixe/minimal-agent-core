Orientation for agents working in this repo. Package overview lives in
[`README.md`](README.md); deferred work in `private/TODOS.md` (untracked); per-change
write-ups in [`docs/changes/`](docs/changes/); deeper design notes and reverse
-engineering captures under `private/research/`.

## What this repo is

This repo is `@minimal-agent/core`, a library package: the agent engine and
the plugin contract. It has no executable. The `minimal-agent` bin, the
REPL, the TUI, argument parsing, and host-mode dispatch live in
[gastonmorixe/minimal-agent-cli](https://github.com/gastonmorixe/minimal-agent-cli).
Do not add CLI or protocol-specific code here (for example, ACP). A protocol
lives in a plugin in `minimal-agent-plugins`. Core keeps only host-agnostic
engine code and the generic plugin contract. The public surface is the
`exports` map in `package.json` (see "Public package" below).

## Build, test, lint

- `bun run check` is the one gate that must stay green. It runs, in order:
  typecheck, lint (oxlint), `format:check`, `biome:check` (format + import
  sort), `docs:check` (typedoc), then `bun test`. It stops at the first
  failure.
- `bun test` runs the whole suite. The skips are live-network E2E behind
  `E2E=1`, plus tests that need the sibling `../minimal-agent-plugins`
  checkout (they skip cleanly without it, see
  `src/test-utils/sibling-repo.ts`). `bunfig.toml` scopes test discovery to
  first-party source: `pathIgnorePatterns` excludes the gitignored, vendored
  trees under `private/` (research clones that ship their own suites and
  dependencies), so the gate never runs third-party tests.
- `bunfig.toml` preloads `src/test-utils/guard-process-exit.ts`. In tests,
  a direct `process.exit` throws instead of ending the run, so a code path
  that quits can never stop `bun test` early with a green exit code. Code that
  quits takes an injectable exit function (the CLI `EditorController`'s
  `exitFn`).
- Lint is `oxlint` (config in `.oxlintrc.json`). Biome owns formatting and
  import-sort only; its linter is off. `bun run format` does NOT sort imports,
  so run `bun run biome:fix` (or `bun run check`) before assuming a tree is
  clean.

## Zero runtime dependencies

`package.json` ships an empty `dependencies` block, by policy, and stays that
way. The agent runs on Bun's standard library plus the TypeScript source in this
repo, with no npm packages resolved at runtime. The only `devDependencies` are
the toolchain (Bun types, Biome, oxlint, typedoc, TypeScript, Husky,
Commitlint); none of it ships in the running agent. Core has no user
installer. Before reaching for a package, write the small piece you
need as a readable file with a test. Optional external binaries (`mdstream`,
`git`) are fetched on demand and must degrade gracefully when missing, they are
never package dependencies. The extended-plugins repo follows the same policy:
every plugin is zero-dependency.

## Public package

The package is `@minimal-agent/core`. Its `exports` map in `package.json` is
the public contract. Hosts (minimal-agent-cli, minimal-agent-web) install core
from git and import only those subpaths. `plugin-api/` is a folder inside this
package, exported as `@minimal-agent/core/plugin-api/*`. It is not a separate
workspace package, so a git install of core resolves with no `workspace:`
reference. Core code imports plugin-api through the same self-reference that
consumers use. `src/architecture/public-api.test.ts` freezes the export list,
checks that every target resolves by name, and keeps `dependencies` empty. A
new or removed subpath updates that test in the same commit.

Plugins import the contract as `@minimal-agent/core/plugin-api/...`, and only
one copy of core loads per process. Both plugin loaders (`PluginLoader.load`
and provider discovery) install `src/plugins/loader/host-core-resolver.ts`, a
Bun runtime plugin. Each `exports` subpath becomes a virtual module served
from the host, even when a plugin has its own `node_modules/@minimal-agent/core`.
Files in any other core copy refuse to load, so a subpath that core does not
export stays unresolvable.

## Core/CLI split bookkeeping

The terminal host moved to minimal-agent-cli. The CLI copy of each moved
file is the canonical one. The core copies that remain are deleted in S34
Phase 4. Four tests in `src/architecture/` keep the move honest:

- `migration-manifest.test.ts`: every file under `src/host`, `src/ui`,
  `src/input`, `src/terminal`, `src/cli`, `src/modes`, `src/plugins/host`,
  `src/e2e` (plus the entry point, abort bus, stderr log sink, and
  safe-stdout) has a row in `migration-manifest.json` that says `core-engine`,
  `cli`, or `delete`, with a target path. A new file there needs a row. When
  a CLI-bound file changes its imports, refresh the list with the one-liner in
  `migration-manifest-scan.ts`.
- `timer-inventory.test.ts`: every non-test core file that calls `setTimeout`
  or `setInterval` is in `timer-inventory.ts` with a count, owner, and reason.
  The list only shrinks: use an `AbortSignal` timeout, an injected sleep or
  clock, or a host port instead of a new timer call.
- `no-direct-writes.test.ts`: engine code (everything but dev tooling and
  the CLI-bound files in the CLI folders) never calls `console.*`,
  `process.stdout.write`, `process.stderr.write`, or `Bun.stdout` /
  `Bun.stderr`. Report through `diag` from `src/bus/diagnostic-bus.ts`
  instead (Debug severity for debug traces). The allow list holds
  `logging/log-stderr.ts` and `infra/safe-stdout.ts` until they move (S34).
- `public-closure.test.ts`: walks every edge (static, dynamic, type-only,
  type-position `import()`) from each `exports` entry. No reached file may
  be CLI-side, use stdio, or hold an ANSI escape literal beyond its entry in
  `PUBLIC_CLOSURE_BASELINE` (`public-closure-scan.ts`). The baseline only
  shrinks.

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
  runtime. See `src/sdk/print-mode.ts` and `src/agent/turn-notice.ts` for the
  pattern.
- **Generators carry a JSDoc `@yields`** (oxlint's jsdoc `require-yields` is on).
- **Capabilities are data, not branching.** Code asks "does this model support
  X?" by reading a `Capabilities` record, never "is this opus-4-7?".
- **Prompts live in markdown, not string literals.** Every model-facing prompt
  (system prompt, tool descriptions, sub-prompts) is a `.md`/`.tmpl.md` file
  loaded through [`src/prompts/prompts.ts`](src/prompts/prompts.ts). Core prompts are under
  [`src/prompts/`](src/prompts/README.md); plugin prompts sit next to the plugin
  (`PROMPT.md`, or `<plugin>/prompts/*`). Templates use `%%name%%` (required,
  throws if unwired) and `%%name?%%` (optional). The rule: prose in markdown,
  control flow (which fragment, what order) in TypeScript. See
  `buildLoopSafetyParagraph` (formerly in the now-removed `src/headers.ts`; the
  Anthropic header logic moved to `../minimal-agent-plugins/ma-llm-anthropic-plugin/`) for the worked
  example, and `docs/changes/2026-05-30-prompts-as-markdown.md` for the rationale.

## How the LLM layer is structured

The provider abstraction lives under [`src/llm/`](src/llm/). It exists so the
agent loop and every host depend on canonical types, never on a
specific vendor's wire format. Every provider (Anthropic, OpenAI, and the
gateways) is a plugin in the sibling `../minimal-agent-plugins/` repo.

Full design rationale, the capability schema, and the phase plan are in
[`private/research/2026-05-28-llm-providers/01-architecture.md`](private/research/2026-05-28-llm-providers/01-architecture.md).
The shipped state and gotchas are in
[`docs/changes/2026-06-12-provider-decoupling-plugin-architecture.md`](docs/changes/2026-06-12-provider-decoupling-plugin-architecture.md).

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

### Provider plugins (`ma-llm-<id>-plugin/`)

Each provider is a PLUGIN in the sibling `../minimal-agent-plugins/` repo, in
its own `ma-llm-<id>-plugin/` folder. Core ships no provider and has no
`plugins/` folder. A plugin ships a `provider.json` descriptor (`id` / `entry`
/ `export`) and exports a `ProviderPlugin` (`id` / `displayName` /
`shortCode` / `register(ctx)`). Inside, the adapter is the only place that
knows a wire format. Shape: `validate.ts` (capability gating),
`request-body.ts` (canonical → wire), `response-stream.ts` (wire SSE →
`CanonicalEvent`), `capabilities.ts` + `models.ts` (registry data),
`headers.ts`, `adapter.ts` (implements the port + `bootstrap<Provider>()` +
the exported `ProviderPlugin`). Gateways that speak OpenAI Chat (Wafer,
OpenRouter, ...) reuse the shared wire layer from the plugin contract instead.

A plugin never imports core `src/`, and no plugin imports another plugin. It
uses the plugin contract (`@minimal-agent/core/plugin-api/*`); today each
plugin carries copies of the contract files it needs in its `lib/` folder.
The I3 ratchet (`src/architecture/architecture.plugin-decoupling.test.ts`)
scans the sibling repo, and its baseline is empty.

`src/llm/provider-discovery.ts` is the EARLY provider loader: it scans each
plugin root for `provider.json`, dynamically imports each `ProviderPlugin`, and
registers it. Host boot (`src/runtime/provider-discovery-boot.ts`, exported
as `./host/provider-discovery-boot`) calls
`registerDiscoveredProviders(...)` over the embedded `<repo>/plugins` root
(empty), the dev-time sibling `../minimal-agent-plugins`, and
`~/.minimal-agent/plugins` (the first-run clone), then
`activateDiscoveredProviders()`, BEFORE any model resolution, so the host
entry point names no provider. `register(ctx)` gets a
`ProviderSetupContext` (`models`, `providers`, `surfaceCodecs`). This is
separate from the `PluginLoader` (which runs later for tools / live-area
slots; provider registration must happen earlier).

### Transport

`AgentCore` sends through the canonical transport
(`src/llm/transport/canonical-send.ts`): it calls `run()`, which resolves the
model to its provider adapter. There is one transport for all providers. The
transport infrastructure (stream watchdog, retry, auth refresh) lives under
`src/llm/transport/`. `src/network/client.ts` is the shared network client
(HTTP/2, HTTP/3, fetch, observers) that adapters get on `RunContext`.
`src/llm/adapter-legacy.ts` converts between the older `SendOptions` /
`StreamedResponse` shapes and the canonical types.

The loop owns retries. `AgentCore` sends one attempt
(`canonicalAttemptFn`), and the pure `decideNext` (`src/sdk/stop-policy.ts`,
the v2 stop table) decides from the error class: `transient` retries forever
with backoff (`src/llm/transport/retry-policy.ts`, 60 s ceiling,
`Retry-After` wins), `recoverable` runs one recovery action
(`src/sdk/run-recovery.ts`), and `permanent` pauses the run (outcome
`waiting`). Adapters stamp the class on their errors through
`classifyUpstreamError` and `tagUpstreamError` (plugin-api
`llm/errors`). No round or retry cap exists; do not add one.
`canonicalSendFn` keeps `withRetry` for side calls outside the loop.
**Do not change the watchdog, retry, or auth-refresh code as a side effect
of provider work.**

### Adding a model or provider

- New model for an existing provider: add a `Capabilities` record in that
  plugin's `capabilities.ts` and a `registerModel({...})` entry in its
  `models.ts` (e.g. under `../minimal-agent-plugins/ma-llm-anthropic-plugin/`).
- New provider: create `../minimal-agent-plugins/ma-llm-<id>-plugin/` mirroring an existing one, implement
  the `ProviderAdapter` port + a `bootstrap<Id>()`, export a `ProviderPlugin`,
  and add a `provider.json` pointing at it. Discovery registers it at startup.
  A provider that speaks another's wire format (e.g. an OpenAI-compatible
  gateway) reuses the shared wire layer from the plugin contract (see
  `ma-llm-openrouter-plugin`, which uses the OpenAI Chat layer). The CLI
  does not validate
  `--model` against the registry (the server is the source of truth), so
  forward-compat ids pass through.

## Lifecycle policy seams + AgentCore

- Policy veto/rewrite uses typed `PolicyDecision` / `LifecyclePort`
  (`src/sdk/lifecycle.ts`). AgentCore never imports HookBus; the host wires
  `LifecyclePortAdapter` over `loader.hooks()`.
- Catalog + decision contract: [`docs/hooks.md`](docs/hooks.md). Channels such as
  `tool.willInvoke` and `message.willSend` are **wired emit sites** (not
  catalog-only). Mode/CLI deny runs before `tool.willInvoke`; silence ≠ allow.
- `AgentCore` is the one agent loop. Hosts build it through
  `buildAgentCore` (`./host-kit/build-agent-core`). The legacy `Agent` class
  is gone. Engine tests build `AgentCore` through the production factory with
  `buildTestCore` (`src/test-utils/test-core.ts`, exported as
  `./testing/test-core`).
- Reference policy fixture (plugins repo): `ma-policy-ref-plugin` (disabled by
  default).

## Slash commands + scheduling (the `commands[]` port)

Plugins contribute slash commands declaratively via a manifest `commands[]`
array (`{name, summary, argHint?, handler}`), mirroring `tuis`/`modes`/
`liveAreaSlots`. The loader collects them into a host-owned registry
(`getCommands` / `hasCommand` / `listCommandInfo` / `dispatchCommand`,
first-wins on cross-plugin name collision). The host intercepts a registered
`/<name>` (parsed by the pure `src/plugins/loader/slash-command-parse.ts`) and acts on
the handler's `CommandResult` union (`expand` → model turn, `notice`/`error`
→ host output, `none` → nothing). Commands work headlessly; the
`slash-menu` plugin is just an autocomplete overlay over the registry (it reads
`ctx.listCommands()`, injected into hook/event contexts).

Out-of-band prompt injection rides the `prompt.inject` bus channel
(`{text, source?}`): the host turns it into a normal queued submit that fires
BETWEEN turns. The live-area handler context gained `emit` so a periodic slot can
use it. The `schedule` plugin (cron engine + `CronCreate/List/Delete` + `/loop`
+ `/schedule` + a 1s heartbeat) is built entirely on these ports. It lives in
the sibling repo (`ma-schedule-plugin`) and imports no core code. See
`docs/changes/2026-05-30-schedule-plugin.md`.

## Git commits (Conventional Commits)

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `chore:`, …). Husky + Commitlint enforce this on `commit-msg`
(`commitlint.config.js`, `.husky/commit-msg`; wired by `prepare` → `husky` on
install). CI runs a `commitlint` job (`bun run commitlint:last` on push; range
lint on PRs). Local check: `echo 'feat: ok' | bun run commitlint`.

## Git commits (agent Co-authored-by trailer)

Every commit made by an agent must include a `Co-authored-by` trailer for the
**current session** (name + short session id). This is a **local audit trail**
("which agent session authored this commit"). It is **not** a GitHub co-author,
not a second GitHub user, and not GitHub contributor attribution.

Format:

```
Co-authored-by: {Name} <{short-sid}@minimal-agent>
```

- `{Name}` — session name (`MINIMAL_AGENT_AGENT_NAME` / `SessionInfo` / TUI),
  e.g. `Veronica`
- `{short-sid}` — first 8 hex characters of `MINIMAL_AGENT_SESSION_ID`, e.g.
  `9b615852` from `9b615852-…`

Example:

```
Co-authored-by: Veronica <a26a1e75@minimal-agent>
```

Put the trailer on its own line at the end of the commit message with a blank
line before it. Prefer a HEREDOC so git keeps the trailer:

```bash
git commit -m "$(cat <<'EOF'
fix: explain the change briefly.

Co-authored-by: Veronica <a26a1e75@minimal-agent>
EOF
)"
```

Or append with Git's native flag:

```bash
git commit -m "fix: explain the change briefly." \
  --trailer "Co-authored-by: Veronica <a26a1e75@minimal-agent>"
```

**Enforcement:** when `MINIMAL_AGENT_SESSION_ID` is set, `.husky/commit-msg`
runs `scripts/check-agent-coauthor.sh` after Commitlint. Missing or wrong
trailers (sid / name) fail the commit. Human commits (env unset) are not gated.
Agents must not bypass with `--no-verify`.
