# Provider-decoupling: provider-agnostic core, repo-separable plugins, a leaf contract package

Date: 2026-06-12 (status updated 2026-10-31)

Status: the physical plugin move (Wave G) is done. Every plugin lives in the
sibling `../minimal-agent-plugins/` repo. I2 (core never imports plugins) and
I3 (plugins never import core) have empty baselines. I1 (provider-clean core)
is down to 5 files. The open work is the I3 ratchet: it keeps an empty
baseline and becomes a strict zero check, and the plugins replace their
copies of the contract with the core dependency. See "Current status".

Sections below "Current status" describe the migration as it ran in June
2026. Paths there use today's layout.

## Why

`src/headers.ts` (and a long tail of other core modules) still named providers
in code, imported plugins, and carried Anthropic wire details. The goal is to
make minimal-agent a real harness: a provider-agnostic agentic core (`src/`)
plus isolated, repo-separable plugins (then `plugins/`, now the sibling
`../minimal-agent-plugins/` repo). Core defines neutral seams (ports): model
registry, capabilities, canonical request/events, transport selection, plugin
loader, capability host. Plugins are the adapters that fill them. Dependency
inversion at repo scale: core never depends on a concrete plugin, plugins never
depend on core internals.

Charter and plan of record: `private/decoupling-refactor-work/CHARTER.md`,
`private/decoupling-refactor-work/PLAN.md`. Predecessor docs archived under `private/docs-archive/`.

## The three invariants

- **I1, provider-clean core.** No file under `src/` may carry a provider
  fingerprint in CODE (identifiers, string literals, file/dir names). Comments
  are exempt. Fingerprints: anthropic, claude, opus, sonnet, haiku, fable,
  openai, openrouter, chatgpt, gpt-N, gemini, mistral, vertex, groq, xai, grok,
  bedrock, x-stainless, claude-cli, claude-code. Wire details (headers, beta
  flags, model ids, API hosts, OAuth endpoints, identity prompts, rate tables)
  live only in that provider's plugin. Core test fixtures use neutral ids
  (`test-model-1`).
- **I2, core never imports plugins.** No file under `src/` may import (static,
  `export ... from`, type-only, or dynamic-with-literal) anything that RESOLVES
  into a top-level plugins tree. Resolution is path-aware: `../plugins/x` from
  `src/headers.ts` is a violation, but `../plugins/types.ts` from
  `src/llm/provider.ts` resolves to `src/plugins/types.ts` (loader infra, legal).
  The one blessed seam is the loader's runtime discovery: a computed (non-literal)
  dynamic `import(abs)`.
- **I3, plugins never import core.** No file under the plugins tree may import
  anything resolving into `src/`, not even type-only. A plugin must compile and
  make sense in its own repo. Plugins consume host data through the handler
  context (`ctx`, `ctx.host`), env, and JSON envelopes, and either re-declare the
  type slice they consume (local structural interface) or depend on the leaf
  contract package.

### How each is enforced

Each invariant has a path-resolution-aware scanner (pure module under
`src/architecture/`), a two-directional ratchet test, and is part of the repo
gate (`scripts/check.ts` runs `test:arch` = `bun test src/architecture` before
the full suite, see `package.json`).

| Invariant | Scanner | Ratchet test | Lint layer |
| --- | --- | --- | --- |
| I1 | `src/architecture/provider-scan.ts` + `provider-baseline.ts` | `src/architecture/architecture.provider-decoupling.test.ts` | (none, test-only) |
| I2 | `src/architecture/core-plugin-import-scan.ts` | `src/architecture/architecture.core-plugin-imports.test.ts` | oxlint `no-restricted-imports`, depth-scoped, `.oxlintrc.json` |
| I3 | `src/architecture/plugin-import-scan.ts` | `src/architecture/architecture.plugin-decoupling.test.ts` | (none, see below) |
| leaf | `src/architecture/plugin-api-leaf-scan.ts` | `src/architecture/architecture.plugin-api-leaf.test.ts` | (none, zero-baseline) |

The ratchets assert exact set/count equality both ways. A file that gains a
violation fails ("move the code, do not extend the baseline"); a baseline file
that gets cleaned also fails ("ratchet down, delete the entry"). The list only
shrinks. Scanner unit tests pin the hard cases: comment stripping, path
resolution, dynamic vs literal imports, `export ... from`, template-literal
specifiers (`src/architecture/*.test.ts`).

The I2 lint rule is real: `.oxlintrc.json` bans `../plugins/**` (and deeper
`../../plugins/**` ...) per directory depth, because oxlint matches the raw
specifier and cannot resolve paths. The I2 baseline is empty, so no exemption
override is left. I1 and I3 stay test-only. The I3 scan runs over the sibling
plugins repo, which a lint rule in this repo cannot see.

## The contract mechanism: HYBRID

`PLAN.md` §1 picks Option 3 (hybrid) over local-slices-only and package-only:

1. **A leaf contract, plugin-api** (`plugin-api/src/`, repo-root sibling of
   `src/`). It started as its own workspace package,
   `@minimal-agent/plugin-api`. Since 2026-10-31 it is a folder inside the
   core package, exported as `@minimal-agent/core/plugin-api/*`, with no
   `package.json` of its own, so a git install of core resolves with no
   `workspace:` reference. Core imports it through the same self-reference.
   It holds the big stable surfaces: shared types and pure, host-state-free
   utilities. It imports NOTHING from `src/` or the plugins (the leaf rule)
   and carries zero provider tokens in code, so a plugin can depend on it
   from its own repo. Core MAY import it: it is the shared abstraction both
   sides depend on (DIP), so the I2 scanner stays scoped to the plugins tree.
2. **`ctx.host` capabilities** for host STATE (the model registry, locks, usage,
   event bus, net). State must not ship in a shared package or you get two
   sources of truth, so it crosses the boundary through the deny-by-default
   capability host (`src/plugins/host/capabilities.ts`, `buildPluginHost` in
   `src/plugins/host/factory.ts`).
3. **Local structural interfaces** stay blessed for narrow one-off slices
   (session-history's `lib/host-types.ts` idiom). Structural typing makes the
   real host object satisfy a re-declared slice at runtime with no cast.

Why not local-slices-only: ~100 type-only sites across 17 plugins would mean 17
hand-maintained mirrors of a 1784-line module and silent drift. Why not
package-only: runtime services (registry mutation, locks, usage) are host state
and belong behind `ctx.host`, not in a shared package.

## What moved where

### Into the leaf package (`plugin-api/src/`)

Each move left a one-line re-export shim at the old `src/` path
(`export * from "@minimal-agent/core/plugin-api/..."` today), so core churn was ~zero and
every existing importer compiles unchanged. Moves are byte-faithful (sha256
verified for the utils).

- **Pure utils** (`plugin-api/src/utils/*`, D-0): `term-width`, `jsonc`,
  `palette`, `sse-parser` (from `src/llm/streaming/`), `unified-diff` (the
  diff colorizer). Old paths `src/term-width.ts`, `src/jsonc.ts`,
  `src/palette.ts`, etc. are now shims.
- **Type cluster** (`plugin-api/src/types/*` and `plugin-api/src/llm/*`, D-1):
  the 1784-line plugin author surface `src/plugins/types.ts` →
  `plugin-api/src/types/plugin.ts` (TUIContext, TUIResult, manifest/handler/
  command types, AgentContext, ModelInfoSnapshot, ColorRequest, ThemeKey, ...).
  The canonical LLM type cluster (`capabilities`, `canonical-events`,
  `canonical-messages`, `canonical-tools`) moved whole, carrying their pure
  runtime helpers (`defaultCapabilities`, `isEvent`, `userText`, ...).
  `src/llm/provider.ts` and `src/llm/provider-plugin.ts` were SPLIT: the neutral
  type slice (`ProviderAuth`, `RunContext`, the `ProviderPlugin`/`SystemPrompt*`
  types, `neutralSystemPrompt`) moved to `plugin-api/src/llm/provider-auth.ts`
  and `.../provider-plugin.ts`; the token-bearing port (`SurfaceId`,
  `ProviderAdapter`, the `ValidationResult`/`Preflight*` types) and the live
  registry runtime STAYED in `src/`.
- **More pure-neutral LLM helpers** (D-2/D-3): `src/llm/errors.ts` split (error
  classes + `categorizeError`/`classifyUpstreamError` → package;
  `UnsupportedCapabilityError` stayed, it needs `canonical-request`),
  `token-estimate.ts` split (`makeCharRatioEstimator` → package;
  `estimateTokensForModel` stayed, it hits the live registry),
  `modality-check.ts` moved whole. Network TYPES → `plugin-api/src/net/types.ts`
  (the `defaultNetworkClient` singleton stays in `src/network/`; it threads to
  providers through `ProviderSessionContext.networkClient`, the port they
  already receive).

### Into `ctx.host` capabilities (D-2/D-3)

`models:read` (`find`/`resolve`/`list`/`findByTags`/`defaultModelId`) and
`models:register` (`register`/`setDefault`) were added to `CapabilityToken` +
`KNOWN_CAPABILITIES` and wired into `buildPluginHost`, backed by
`src/llm/model-registry.ts`. The package keeps a leaf-clean structural copy
(`plugin-api/src/types/host-capabilities.ts`, neutral `ModelView` widening
`surfaceId` to `string`), so the loader hands the real registry view into a
package-typed `ctx.host.models` with no cast. Provider plugins do not get
`ctx.host`. Their `register(ctx)` gets a `ProviderSetupContext` (`models`,
`providers`, `surfaceCodecs`) built by `src/llm/provider-discovery.ts`, so they
register their catalog through it. `models:read` serves TUI plugins (memory,
session-info, model-info).

### Out to the Anthropic plugin

`src/metadata.ts` (device-id mimicry, the `metadata.user_id` wire shape) →
`ma-llm-anthropic-plugin/identity.ts`. The provider-neutral session UUID stays in
core (`src/session/session-id.ts`) and is threaded in as an argument. The login cluster
(`oauth-login.ts`, `auth-store.ts`, `commands/login.ts`) turned out to be
provider-neutral infrastructure already, so B-3 neutralized incidental provider
strings and ratcheted them out of I1 rather than physically moving them; the
Anthropic specifics already live in `ma-llm-anthropic-plugin/oauth-login.ts`.

### The transport flip (B-0)

`auto` transport mode now routes EVERY registry-resolvable model through the
canonical `canonicalSendFn`; canonical is the default for all providers.
`src/llm/transport/select-transport.ts` no longer compares against a provider
id (that removed its last in-code provider token, ratcheting it out of I1).
At the time, rollback was the `MINIMAL_AGENT_LEGACY_TRANSPORT=1` env var, and
the legacy Anthropic stack (`client.ts`, `headers.ts`, ...) stayed live behind
it. The B-5 deletion has since removed that stack and the env var. The
canonical transport is the only one.
Two deliberate characterization-pin edits accompanied the flip and nothing else
on the wire: api-key requests gain the full non-OAuth beta set (B2), and the
canonical builder now omits redact-thinking from conversations to match legacy
(B3a). OAuth conversations are byte-unchanged (equivalence-pinned).

## Provider continuity

All three providers stay byte-identical, pinned by characterization suites that
moved with the code, not weakened to make a move pass:

- `ma-llm-anthropic-plugin/` (then in the core `plugins/` tree): 144 pass / 0 fail (beta-flags, headers, request-body,
  session-info, the captured-SSE end-to-end replay). The B-0 flip's live OAuth
  smoke (`canonical-send.test.ts -t live`) did a real Anthropic round-trip
  through the canonical stack; the api-key live smoke is deferred to the bake
  (no api-key credential on the build machine).
- Pure moves are proven green BEFORE and AFTER with no test edits (utils,
  errors/token-estimate/modality-check). The diff colorizer move was pinned by a
  byte-parity test (`src/ui/render/unified-diff.test.ts`) against the plugin's SGR
  bytes; sse-parser parity rides the provider adapter suites.
- The TUI seams (Wave A) preserve behavior: the turn-attachment registry
  (`src/agent/turn-attachments.ts`) and replay-renderer registry
  (`src/host/session-replay-derivers.ts`) consume plugin factories through the
  loader's blessed dynamic-import seam, with core-local fallbacks, and the
  existing agent/replay tests pass unmodified. A1's replay round-trip was
  byte-identical across all fixtures.

## The ratchet model

Baselines shrink monotonically toward zero. The end state (Wave F) is
strict-zero assertions with the baselines deleted and the EXEMPT set reduced to
the scanner/test files that must name the tokens. Until then, the gate stays
green by tracking the frozen counts. Because the tree is worked by parallel
sweeps, a transient down-direction red can appear when one sweep re-points its
imports before deleting its baseline rows; it clears when that sweep lands its
own baseline edit. I observed exactly this during writing (an llm-openai sweep
landed mid-run), and it resolved to green.

## Current status (verified 2026-10-31)

- **Wave G (the physical move) is done.** Every first-party plugin lives in
  the sibling `../minimal-agent-plugins/` repo as `ma-*-plugin/`. Core has no
  `plugins/` folder. The provider loader and the TUI loader discover plugins
  from the sibling checkout at dev time and from `~/.minimal-agent/plugins`
  on an installed box.
- **plugin-api** is a folder in the core package, exported as
  `@minimal-agent/core/plugin-api/*` (see "The contract mechanism"). The
  plugins do not depend on core yet. Each carries copies of the contract
  files it uses in its `lib/` folder.
- **I1** (`provider-baseline.ts`): GREEN. The baseline is 5 files, down from
  76 at freeze: `auth/auth.ts` and its test, plus three transport tests that
  use real model ids as data.
- **I2** (core→plugins): GREEN. The baseline is empty.
- **I3** (plugins→src): GREEN. The scan covers the sibling repo, and the
  baseline is empty (it was 242 sites in 121 files at freeze). No plugin
  imports core `src/`, and no plugin imports another plugin.
- **leaf** (`plugin-api`): GREEN, zero, no baseline. It also flags a
  self-import of any core subpath outside plugin-api, because
  `@minimal-agent/core/sdk/*` resolves into `src/`.

Open work:
- **The I3 ratchet.** Its baseline is empty, but it is still a ratchet. It
  becomes a strict zero assertion with the baseline deleted.
- **The vendored contract copies.** The plugins replace their `lib/` copies
  with a real dependency on `@minimal-agent/core/plugin-api/*`.
- **The I1 tail.** `auth/auth.ts` and the three transport tests.

## The capability host

The capability host lives in `src/plugins/host/` (`capabilities.ts`,
`factory.ts`, and `providers/`). It is the one plugin API. There is no second
plugin architecture: the old `v2` plugin tree, `plugin-sdk.ts`, and
`bash-tool-plugin.ts` are gone. Provider plugins use the narrower
`ProviderSetupContext` at registration time.
