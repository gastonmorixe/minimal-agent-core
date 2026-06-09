# feat: automatic LSP / linter / formatter diagnostics after Edit/Write

**Date**: 2026-06-07
**Type**: feat
**Scope**: src/plugins/hooks/ (tool-lifecycle contract + channel shape),
src/agent.ts (emit + render), src/agent/tool-format.ts (renderer + annotation),
plugins/diagnostics/ (new plugin)

## Problem

The agent edited blind. After an `Edit`/`Write` it got back `File edited: ...`
and moved on, with no signal about type errors, lint violations, or formatting
the change introduced. Those surfaced one of two ways: a later `bun run check`
(if the model remembered), or the user pointing them out. Each is a wasted turn.
Type errors are the worst case: they are invisible to grep and lint, and the
model most often needs a second edit cycle to find them.

## Goals

- **Immediate feedback**: report type/lint/format problems on the SAME turn as
  the edit that caused them, scoped to the just-written file.
- **Decoupled**: ship as a PLUGIN attached to a lifecycle hook, not agent-core
  code. The agent exposes a generic seam; the plugin attaches.
- **Use what's there**: detect the tools the project ALREADY has (no installs).
- **The agent owns the TUI**: the plugin provides structured data; the agent
  renders it in its own chrome.
- **Compact for the model**: a few-token annotation, not a wall of output.
- **Never break the tool loop**: a misbehaving tool/server degrades silently.

## Design

### The generic seam (agent core)

`tool.didInvoke` was declared in the channel catalog but never emitted. We
changed its shape from `broadcast-async` to **`chain`** and now emit it from the
agent's tool loop right after a tool returns, before rendering:

```
executeTool() → emitChain("tool.didInvoke", payload) → render(payload union)
```

The payload (`src/plugins/hooks/tool-lifecycle.ts`) is a tool-agnostic contract
with two accumulators a chain listener fills:

- `findings: Finding[]` : structured results the AGENT renders.
- `notes: string[]` : model-facing one-liners the agent wraps in a
  `<ma::agent::diagnostics>` annotation.

This is a reusable extension point: any plugin can augment a tool result. The
agent knows about `findings`/`notes`, not about LSP/linters/formatters.

### The rendering (agent core)

`src/agent/tool-format.ts` gained pure renderers:

- `renderFindingsPanel(findings)` : colored rows inside the existing tool-block
  gutter (`│ ┊ ╰`), severity dots (`●` red/gold/sky), dim codes/locations, a
  `·`-joined summary. Reuses the exact palette + glyph vocabulary of the tool
  preview : no new visual language.
- `formatDiagnosticsAnnotation(notes)` : the `<ma::agent::diagnostics>` block.
  Registered in `ANNOTATION_PREFIXES`, so it is stripped from the human
  transcript (the model reads it; the user sees the panel).

`reopenFrameCloser` fuses the diagnostics panel onto the tool block by turning
the preview's trailing `╰` into a `│` so the panel owns the final `╰`.

### The plugin (`plugins/diagnostics/`)

Imports NOTHING from `src/`. Meets the agent only at the structural payload
shape (guarded by `structural-contract.test.ts`). Patterns:

- **Detection** (`lib/detect.ts`): probe `node_modules/.bin` + config files +
  package.json devDeps. No installs. tsgo needs a tsconfig; biome/oxlint by bin.
- **Strategy** (`lib/provider.ts`): each tool is a `DiagnosticProvider`.
  - `providers/tsgo-provider.ts`: PERSISTENT `tsgo --lsp` (warm 2-3ms/edit),
    guarded by a **Circuit Breaker** (`lib/circuit-breaker.ts`).
  - `providers/biome-provider.ts`, `providers/oxlint-provider.ts`: spawn-per-call.
- **Adapter** (`adapters/*.ts`): each tool's JSON → `Finding[]`.
- **Facade + DI** (`lib/runner.ts`, `lib/service.ts`): run providers
  concurrently, timeout-bounded, degrade on failure (never throw).
- **Compaction** (`lib/format-notes.ts`): severity floor + dedup + cap.
- **Handler** (`handlers/on_tool_did_invoke.ts`): the single attach point.

## Measurements (this repo, M1 Pro)

| signal | mechanism | per-edit |
|---|---|---|
| type (tsgo) | persistent LSP pull | **2-3 ms** warm (vs ~316ms spawn) |
| format (biome) | spawn, `--reporter=json` | ~55 ms |
| lint (oxlint) | spawn (opt-in) | ~400 ms (startup-bound) |

## Config

`plugins.diagnostics` in `~/.minimal-agent/config.jsonc`. Defaults: types +
format on, lint off, `severityFloor: "warning"`, `maxInline: 8`. Env kill-switch
`MINIMAL_AGENT_DIAGNOSTICS_DISABLED=1`.

## Why a plugin, not agent core

The agent's only diagnostics knowledge is the generic `findings`/`notes`
contract and how to render them. Everything tool-specific (which linters exist,
how to spawn them, how to parse their output, the persistent LSP lifecycle)
lives in the plugin. Adding a language (pyright, rust-analyzer) is a new
provider + adapter + one detection-registry entry, touching no agent code.

## Tests

- Agent seam + renderer: `src/agent/diagnostics-*.test.ts`,
  `src/plugins/hooks/tool-lifecycle.test.ts`.
- Plugin: 54 tests across `plugins/diagnostics/**` including REAL-binary
  integration tests for biome, oxlint, and the tsgo LSP (auto-skip when a
  binary is absent).

## Risks / mitigations

- tsgo crash/leak → circuit breaker + dispose on process exit + lazy boot.
- oxlint 400ms → off the hot path (concurrent + timeout), lint off by default.
- context noise → severity floor + dedup + cap; ~60 tokens for 2 diagnostics.
- non-TS repos → `handles(path)` gates by extension; tsgo never boots without a
  tsconfig.
