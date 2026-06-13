# Provider-decoupling: provider-agnostic core, repo-separable plugins, a leaf contract package

Date: 2026-06-12

Status: migration in progress, enforced by ratchet. The three invariants are
gated and green in both directions; their baselines are shrinking toward zero
but are not yet empty (see "Honest current status").

## Why

`src/headers.ts` (and a long tail of other core modules) still named providers
in code, imported plugins, and carried Anthropic wire details. The goal is to
make minimal-agent a real harness: a provider-agnostic agentic core (`src/`)
plus isolated, repo-separable plugins (`plugins/`, future home
`../minimal-agent-plugins/`). Core defines neutral seams (ports): model
registry, capabilities, canonical request/events, transport selection, plugin
loader, capability host. Plugins are the adapters that fill them. Dependency
inversion at repo scale: core never depends on a concrete plugin, plugins never
depend on core internals.

Charter and plan of record: `private/decoupling-refactor-work/CHARTER.md`,
`private/decoupling-refactor-work/PLAN.md`. Predecessor doc:
`docs/changes/2026-06-09-fable-5-hardening-and-headers-decoupling.md`.

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
| I1 | `src/architecture/provider-scan.ts` + `provider-baseline.ts` | `src/architecture.provider-decoupling.test.ts` | (none, test-only) |
| I2 | `src/architecture/core-plugin-import-scan.ts` | `src/architecture.core-plugin-imports.test.ts` | oxlint `no-restricted-imports`, depth-scoped, `.oxlintrc.json` |
| I3 | `src/architecture/plugin-import-scan.ts` | `src/architecture.plugin-decoupling.test.ts` | (none yet, see below) |
| leaf | `src/architecture/plugin-api-leaf-scan.ts` | `src/architecture.plugin-api-leaf.test.ts` | (none, zero-baseline) |

The ratchets assert exact set/count equality both ways. A file that gains a
violation fails ("move the code, do not extend the baseline"); a baseline file
that gets cleaned also fails ("ratchet down, delete the entry"). The list only
shrinks. Scanner unit tests pin the hard cases: comment stripping, path
resolution, dynamic vs literal imports, `export ... from`, template-literal
specifiers (`src/architecture/*.test.ts`).

The I2 lint rule is real: `.oxlintrc.json` bans `../plugins/**` (and deeper
`../../plugins/**` ...) per directory depth, because oxlint matches the raw
specifier and cannot resolve paths. A final override exempts the frozen I2
violators and is marked `// RATCHET: do not extend`. I1 and I3 stay test-only:
the I3 exemption list would be ~120 files of churn against a baseline Wave D is
already shrinking file-by-file, so it is deferred until that list is small.

## The contract mechanism: HYBRID

`PLAN.md` §1 picks Option 3 (hybrid) over local-slices-only and package-only:

1. **A leaf contract package, `@minimal-agent/plugin-api`** (`plugin-api/`,
   repo-root sibling of `src/` and `plugins/`). Its own `package.json`, zero
   runtime deps, `"type": "module"`, consumed via Bun workspaces today
   (`"workspaces": ["plugin-api"]` in the root `package.json`) and via a `file:`
   dep from the sibling repo after the Wave-G split. It holds the big stable
   surfaces: shared types and pure, host-state-free utilities. It imports
   NOTHING from `src/` or `plugins/` (the leaf rule) and carries zero provider
   tokens in code, so a plugin can depend on it from its own repo. Core MAY
   import it: it is the shared abstraction both sides depend on (DIP), so the I2
   scanner stays scoped to the plugins tree.
2. **`ctx.host` capabilities** for host STATE (the model registry, locks, usage,
   event bus, net). State must not ship in a shared package or you get two
   sources of truth, so it crosses the boundary through the deny-by-default
   capability host (`src/plugins/v2/host-capabilities.ts`,
   `buildPluginHostV2` in `src/plugins/v2/host.ts`).
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
(`export * from "@minimal-agent/plugin-api/..."`), so core churn was ~zero and
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
`KNOWN_CAPABILITIES` and wired into `buildPluginHostV2`, backed by
`src/llm/model-registry.ts`. The package keeps a leaf-clean structural copy
(`plugin-api/src/types/host-capabilities.ts`, neutral `ModelView` widening
`surfaceId` to `string`), so the loader hands the real registry view into a
package-typed `ctx.host.models` with no cast. Caveat (see "v2 convergence"):
provider plugins do not yet receive `ctx.host`, so `models:register` has no live
consumer until the provider loader converges; `models:read` is the immediately
useful half for TUI plugins (memory, session-info, model-info).

### Out to the Anthropic plugin

`src/metadata.ts` (device-id mimicry, the `metadata.user_id` wire shape) →
`plugins/llm-anthropic/identity.ts`. The provider-neutral session UUID stays in
core (`src/session-id.ts`) and is threaded in as an argument. The login cluster
(`oauth-login.ts`, `auth-store.ts`, `commands/login.ts`) turned out to be
provider-neutral infrastructure already, so B-3 neutralized incidental provider
strings and ratcheted them out of I1 rather than physically moving them; the
Anthropic specifics already live in `plugins/llm-anthropic/oauth-login.ts`.

### The transport flip (B-0)

`auto` transport mode now routes EVERY registry-resolvable model through the
canonical `canonicalSendFn`; canonical is the default for all providers.
`src/llm/transport/select-transport.ts` no longer compares against a provider
id (that removed its last in-code provider token, ratcheting it out of I1).
Rollback is a single env var: `MINIMAL_AGENT_LEGACY_TRANSPORT=1` maps the mode
to `off` and wins over `MINIMAL_AGENT_CANONICAL_TRANSPORT` (documented in
README). The legacy Anthropic stack (`client.ts`, `headers.ts`, ...) is NOT
deleted; it stays live behind the env var until the B-5 deletion after the bake.
Two deliberate characterization-pin edits accompanied the flip and nothing else
on the wire: api-key requests gain the full non-OAuth beta set (B2), and the
canonical builder now omits redact-thinking from conversations to match legacy
(B3a). OAuth conversations are byte-unchanged (equivalence-pinned).

## Provider continuity

All three providers stay byte-identical, pinned by characterization suites that
moved with the code, not weakened to make a move pass:

- `plugins/llm-anthropic/`: 144 pass / 0 fail (beta-flags, headers, request-body,
  session-info, the captured-SSE end-to-end replay). The B-0 flip's live OAuth
  smoke (`canonical-send.test.ts -t live`) did a real Anthropic round-trip
  through the canonical stack; the api-key live smoke is deferred to the bake
  (no api-key credential on the build machine).
- Pure moves are proven green BEFORE and AFTER with no test edits (utils,
  errors/token-estimate/modality-check). The diff colorizer move was pinned by a
  byte-parity test (`src/render/unified-diff.test.ts`) against the plugin's SGR
  bytes; sse-parser parity rides the provider adapter suites.
- The TUI seams (Wave A) preserve behavior: the turn-attachment registry
  (`src/agent/turn-attachments.ts`) and replay-renderer registry
  (`src/session-replay-derivers.ts`) consume plugin factories through the
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

## Honest current status (verified 2026-06-12)

`bun test`: 5042 pass / 10 skip / 0 fail (372 files). `bun run typecheck`
(tsgo): exit 0. `bun test src/architecture`: 73 pass / 0 fail.

- **I1** (`provider-baseline.ts`): ratchet GREEN. Baseline is 63 files (down
  from 76 at freeze), and the live scan returns exactly those 63. Dominated by
  the legacy Anthropic client stack (`client.ts`, `headers.ts`, `client/*`,
  `auth.ts`) awaiting B-5 deletion, plus neutral seams still carrying defaults
  (`llm/model-registry.ts`, `llm/provider.ts`, `llm/canonical-request.ts`,
  `llm/adapter-legacy.ts`, `llm/transport/canonical-send.ts`, `media/ingest.ts`)
  and ~40 core tests using real model ids as data. NOT yet zero.
- **I2** (core→plugins): ratchet GREEN. Baseline is down to a single site,
  `src/headers.ts: 1` (it dies with the legacy stack in B-4), from 34 sites / 17
  files at freeze. Wave A severed the rest (the 6 `index.ts` sites, the replay
  cluster, the core-test reach-ins via a synthetic `src/llm/test-fixtures.ts`).
- **I3** (plugins→src): ratchet GREEN. Live count is 150 sites / 64 files, down
  from 242 sites / 121 files at freeze. Remaining by plugin: llm-anthropic 76
  (biggest, much dies naturally with B-4/B-5, swept in D-5), schedule 18,
  quota-status 17, llm-openai 12, llm-openrouter 7, file-lock 6, usage 6,
  session-info 3, memory 2 (ratified residual: `summarize.ts` needs an
  authenticated LLM call and there is no `auth`/`llm:send` capability yet),
  diagnostics/history/web-search 1 each (host-runtime or loader-harness
  residuals blocked on a capability/util that has not landed). Four plugins are
  fully at zero (config, diff-view, model-info, interleave-thinking).
- **leaf** (`plugin-api`): GREEN, zero, no baseline. The real package has 0 host
  imports across all its `.ts` files, proven against the live tree and red-first
  against a planted reach-in.

So: the gate is real and enforced today, but the migration is mid-flight. The
honest framing is "in progress, with an enforced down-only ratchet," not "done."

## v2 convergence (open)

`src/plugins/v2/` is a second plugin architecture beside the v1 loader. The
finding (D-2/D-3, task #bea3cb): the capability host is the keeper and should
not be dissolved. The remaining work is making the provider loader
(`src/llm/provider-discovery.ts` + `activateProviderPlugins`, which calls
`ProviderPlugin.register()` with no context) able to consume the same capability
host as the TUI loader, then deleting the `plugin-sdk.ts`/`bash-tool-plugin.ts`
experiment and renaming the surface to drop "v2" (a single unversioned plugin
API). That rename should land only after the provider path is folded in, or it
is just churn.

## Future: the physical move (Wave G)

The forcing function is moving `plugins/` to `../minimal-agent-plugins/` as its
own repo, with `plugin-api` consumed via a `file:` dep. The scanners already
take plugin roots as a parameter (`DEFAULT_PLUGIN_ROOTS = ["plugins"]`), so the
gate keeps working when plugins live at the external root. D-0 ran a resolution
smoke that built the post-split sibling layout in a tmp tree and proved
`@minimal-agent/plugin-api` resolves from a plugin file there. Wave G is gated
on Waves A-F being green and stable, and on the host running green with the
plugins tree absent (degraded: builtins only) and fully featured with the
sibling present.
