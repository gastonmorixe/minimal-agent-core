# diagnostics

Automatic LSP / linter / formatter feedback after `Edit`/`Write`. Subscribes to
the agent's `tool.didInvoke` chain hook, runs the diagnostic tools the project
already has on the just-written file, and hands back:

- **structured findings** the agent renders into its tool-block chrome, and
- a compact **`<ma::agent::diagnostics>`** note for the model.

So when the model writes a type error, it sees it on the same turn instead of
discovering it a build later.

## What it detects (no installs)

Probes `node_modules/.bin` + config files + `package.json` devDeps. Uses
whatever is present:

| tool | signal | how it runs | speed |
|---|---|---|---|
| **tsgo** (types) | tsconfig + bin | persistent `tsgo --lsp` (reused) | ~2-3ms warm |
| **biome** (format) | bin / biome.json | spawn `check --reporter=json` | ~55ms |
| **oxlint** (lint) | bin / .oxlintrc | spawn `-f json` (opt-in) | ~400ms |

A project with none of these installed gets a silent no-op.

## Config

`~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "diagnostics": {
      "enabled": true,
      "type": true,        // persistent tsgo LSP (type errors)
      "format": true,      // biome
      "lint": false,       // oxlint (startup-heavy; opt-in)
      "severityFloor": "warning",  // "error" | "warning" | "info"
      "maxInline": 8,      // cap findings shown/sent
      "timeoutMs": 2000    // per-provider ceiling
    }
  }
}
```

Disable entirely: `plugins.diagnostics.enabled = false`, or
`MINIMAL_AGENT_DIAGNOSTICS_DISABLED=1`.

## How it looks

Clean edit (calm, one badge on the existing footer):

```
  ✦ Edit  src/foo.ts
  ╰ 1 replacement · ✓ clean
```

Edit that introduced a problem (panel fused onto the tool block):

```
  ✦ Edit  src/foo.ts
  ┊
  ╰ ✘ 2 errors · 0 warnings
      ● 12:5  TS2322  Type 'string' is not assignable to type 'number'.
      ● 7:1   no-unused-vars  'x' is declared but never used.
```

The model separately reads a compact, stripped-from-the-transcript block:

```
<ma::agent::diagnostics count="2">
12:5 error TS2322 Type 'string' is not assignable to type 'number'.
7:1 warning no-unused-vars 'x' is declared but never used.
</ma::agent::diagnostics>
```

## Architecture (decoupled)

This plugin imports nothing from the agent's `src/`. It meets the agent only at
the structural `tool.didInvoke` payload shape (`findings`/`notes` accumulators).

```
handlers/on_tool_did_invoke.ts   the single attach point (chain listener)
lib/detect.ts                    probe the project for available tools
lib/provider.ts                  DiagnosticProvider Strategy interface
lib/runner.ts                    concurrent + timeout + degrade (Facade)
lib/service.ts                   composition root (detect → providers → runner)
lib/circuit-breaker.ts           guards the persistent LSP child
lib/format-notes.ts              severity floor + dedup + cap (compaction)
lib/config.ts                    plugins.diagnostics resolution
lib/lsp-client.ts                minimal JSON-RPC stdio LSP client
providers/tsgo-provider.ts       persistent type diagnostics
providers/biome-provider.ts      format (spawn)
providers/oxlint-provider.ts     lint (spawn)
adapters/{lsp,biome,oxlint}.ts   each tool's output → Finding[]
```

The agent owns all rendering; this plugin only supplies data.
