# SessionHistory tool, the v2 capability host, and the plugin-decoupling ratchet

Date: 2026-06-09

## What shipped

Three layered changes, each useful alone, designed together:

1. **The v2 capability host is now real.** `src/plugins/v2/host-capabilities.ts`
   had the design (capability tokens, `SessionsReadApi`, `BlobsReadApi`,
   `PluginHostV2`) but no implementation. This change adds the provider
   adapters (`src/plugins/v2/providers/sessions-read.ts`, `blobs-read.ts`),
   the frozen-host factory (`src/plugins/v2/host.ts`, `buildPluginHostV2`),
   a validated `capabilities: [...]` manifest field, and loader wiring that
   hands each plugin a per-plugin memoized `ctx.host` carrying ONLY its
   granted namespaces (deny-by-default).

2. **`plugins/session-history/` and the `SessionHistory` tool.** Paginated,
   filterable read access to any saved session's recorded transcript:
   `window` (default: latest 10 records, stable indexes, anchor start/end,
   offset/limit/previewChars), `meta`, `list`, `search`, `tool_calls`,
   `blob` (raw spilled tool output), and `dump` (the full `--dump` shape).
   `sid` defaults to `last`. Every paged response carries an explicit
   next-page hint. The plugin imports NOTHING from `src/` — it re-declares
   the host slice it consumes as local structural interfaces
   (`lib/host-types.ts`) and reads only through `ctx.host`. It is the first
   real consumer of the capability host.

3. **The plugin-decoupling ratchet.**
   `src/architecture.plugin-decoupling.test.ts` +
   `src/architecture/plugin-import-scan.ts` freeze the per-file count of
   `src/` import sites under `plugins/` (242 sites at freeze). Both
   directions fail fast: a new site (or one more site in a dirty file)
   fails the build, and a cleanup that is not ratcheted down in the
   baseline also fails. Same fitness-function idiom as
   `architecture.provider-decoupling.test.ts`.

`--dump` (`src/commands/dump.ts`) was refactored onto the same
`sessions:read` provider, so the CLI dump and the tool's `{action:"dump"}`
share one rendering path.

## Naming: SessionHistory vs SessionInfo

Deliberate contrast, stated in both tool descriptions:

- `SessionInfo` = LIVE runtime state of the current run (context fullness,
  quota, cost, uptime).
- `SessionHistory` = the RECORDED transcript (this session's earlier turns
  or any past session), read from `~/.minimal-agent/sessions/<sid>.jsonl`.

## Design notes

- **Ports & adapters / DIP.** `host-capabilities.ts` is the port;
  `providers/*` are the host-side adapters; the plugin's `host-types.ts`
  is the consumer-side structural re-declaration. No plugin → src import,
  even type-only.
- **Bounded DTOs.** Only clipped `RecordView`/`SearchHit`/`ToolCallHit`
  values cross the boundary, never raw records; `blob.read` clamps to
  `maxBytes` (hard cap 1 MB).
- **Stable indexes.** A record's `index` is its position in the
  append-only log, so cursors never shift under a running session.
- **Frozen value objects.** The host (and each namespace) is
  `Object.freeze`-d, mirroring `AgentContext`.
- **Test injection.** `PluginLoader.load({hostOptions: {sessionsDir}})`
  lets integration tests run capability-backed tools against a temp store.

## Tests

- `src/architecture/plugin-import-scan.test.ts` — scanner unit tests.
- `src/architecture.plugin-decoupling.test.ts` — the ratchet.
- `src/plugins/v2/providers/sessions-read.test.ts` (26) and
  `blobs-read.test.ts` — providers against a temp `SessionStore`.
- `src/plugins/v2/host.test.ts` — grant model, freezing, injection.
- `src/plugins/manifest.test.ts` — `capabilities` validation block.
- `src/plugins/loader.host.test.ts` — loader → ctx.host wiring.
- `plugins/session-history/handlers/session_history.test.ts` (20) — the
  handler against a fake host (decoupling proof: the fake satisfies the
  local structural types).
- `src/plugins/session-history.integration.test.ts` (9) — real loader +
  real store + real plugin end-to-end; doubles as the drift guard for the
  plugin's structural types.

## Migration path for the 242 frozen violations

The baseline only shrinks. When an existing plugin (e.g. `session-info`,
`quota-status`, `memory`) is migrated onto context seams or capability
namespaces (`tasks:read`, `memory:read` are reserved tokens), its entries
ratchet down in the same commit. New plugins start at zero and stay there.
