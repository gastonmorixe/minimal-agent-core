# diagnostics

Automatic type / linter / formatter feedback after `Edit`/`Write`. Subscribes to
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
| **tsgo** (type) | tsconfig + bin | persistent `tsgo --lsp` (reused) | ~2-3ms warm |
| **tsc** (type) | tsconfig + bin, no tsgo | spawn `tsc --noEmit` per edit | ~300-800ms |
| **biome** (format) | bin / biome.json | spawn `check --reporter=json` | ~55ms |
| **oxlint** (lint) | bin / .oxlintrc | spawn `-f json` (opt-in) | ~400ms |
| **sourcekit-lsp** (apple) | Package.swift / .xcodeproj | persistent LSP (reused) | ~2-5ms warm |

**Type provider priority**: `tsgo` wins when both `tsgo` and `tsc` are present.
`tsc` is the fallback for projects that have the standard `typescript` package
(tsc / tsserver) but not the Go-native `tsgo` preview compiler. Both respect
`config.type: false`.

A project with none of these installed gets a silent no-op.

## Config

`~/.minimal-agent/config.jsonc`:

```jsonc
{
  "plugins": {
    "diagnostics": {
      "enabled": true,
      "type": true,        // tsgo or tsc (type errors)
      "format": true,      // biome
      "lint": false,       // oxlint (startup-heavy; opt-in)
      "apple": true,       // sourcekit-lsp for Swift/Obj-C/C/C++
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

### Flow

```
                           on_tool_did_invoke.ts
                           +------------------------------+
                           |  post-Edit/Write hook        |
                           +------------------------------+
                                           |
                                           |
                                           v

                            DiagnosticsService
                            +----------------------------+
                            |   Facade per root          |
                            +----------------------------+
                                           |
                                           |
                                           v
                |                                |                          |
 +----------------------------+   +----------------------------+   +----------------+
 |     TsgoLspProvider        |   |     TscSpawnProvider       |   |    Biome       |
 | persistent LSP (2-3ms)     |   | spawn tsc --noEmit         |   | format, ~55ms  |
 | preferred type provider    |   | fallback (300-800ms)       |   |                |
 +----------------------------+   +----------------------------+   +----------------+
                        |                                   |
                        |                                   |
                        |                                   |
          +--------------------------+       +----------------------------+
          |     OxlintProvider       |       | SourceKitLsp               |
          | spawn, ~400ms            |       | persistent LSP             |
          | opt-in (config.lint)     |       | Swift / Obj-C / C          |
          +--------------------------+       +----------------------------+




  Detection order: tsgo, then tsc (suppressed if tsgo found), oxlint, biome, sourcekit

  All providers behind the DiagnosticProvider Strategy interface
  Respects config.type / config.lint / config.format / config.apple gates
```


```
handlers/on_tool_did_invoke.ts              single attach point (chain listener)
lib/detect.ts                               probe the project for available tools
lib/detect.test.ts                          22 tests (all providers)
lib/provider.ts                             DiagnosticProvider Strategy interface
lib/runner.ts                               concurrent + timeout + degrade (Facade)
lib/runner.test.ts                          7 tests (merge, skip, degrade, timeout)
lib/service.ts                              composition root (detect → providers → runner)
lib/service.test.ts                         10 tests (wiring, dedup, filtering)
lib/circuit-breaker.ts                      guards persistent LSP children
lib/circuit-breaker.test.ts                 6 tests (open, close, half-open, dead)
lib/format-notes.ts                         severity floor + dedup + cap (compaction)
lib/format-notes.test.ts                    7 tests (line format, filter, dedup)
lib/config.ts                               plugins.diagnostics resolution
lib/config.test.ts                          6 tests (defaults, overrides, malformed)
lib/lsp-client.ts                           minimal JSON-RPC stdio LSP client
lib/lsp-client.test.ts                      9 tests (languageIdFor mappings)
lib/structural-contract.test.ts             1 test (plugin Finding ⇆ agent Finding)
providers/tsgo-provider.ts                  persistent type (LSP, preferred)
providers/tsgo-provider.integration.test.ts 2 tests (real tsgo LSP)
providers/tsc-provider.ts                   spawn-based type fallback (tsc --noEmit)
providers/tsc-provider.test.ts              8 tests (handles, interface, dispose)
providers/tsc-provider.integration.test.ts  2 tests (real tsc, clean + broken)
providers/biome-provider.ts                 format (spawn)
providers/oxlint-provider.ts                lint (spawn)
providers/spawn-providers.integration.test.ts 3 tests (real biome + oxlint)
providers/spawn.ts                          shared subprocess helper (Bun-first, Node fallback)
providers/sourcekit-lsp-provider.ts         apple (persistent LSP)
providers/sourcekit-lsp-provider.integration.test.ts 5 tests (Swift, Obj-C, C, warm)
adapters/lsp.ts                             LSP Diagnostic[] → Finding[]
adapters/tsc.ts                             tsc --noEmit output → Finding[]
adapters/tsc.test.ts                        10 tests (parse, continuation, filter, edge)
adapters/adapters.test.ts                   9 tests (oxlint, biome, lsp shapes)
```

The agent owns all rendering; this plugin only supplies data.

### Detection registry (ordered)

```
REGISTRY scan order:
  1. tsgo           (kind: type, persistent, requires tsconfig)
  2. tsc            (kind: type, suppressedBy: ["tsgo"], requires tsconfig)
  3. oxlint         (kind: lint, optional config, opt-in)
  4. biome          (kind: format, optional config)
  5. sourcekit-lsp  (kind: apple, persistent, from PATH, optional signal)
```

When a tool has `suppressedBy`, it is skipped if the suppressing tool was
already detected. This ensures only one type provider is active per project.

## Out-of-scope diagnostics

When the model writes a file **outside** the project's configured scope (e.g.
`tsconfig.json` has `"include": ["src", "plugins"]` and the file lands in
`private/tmp/experiment.ts`), the normal providers return nothing — the LSP or
spawn tool silently ignores the file.

The plugin detects this and runs a lightweight **direct fallback** that checks
the file anyway, bypassing project exclusions. Findings from this path carry an
`scope: "ad-hoc"` signal so the model knows they are harness-injected, not the
project's own linting rules. No wild goose chases on intentional ad-hoc files.

### Two-phase check

```
DiagnosticsService.check(path, text)
        │
        ├─ Phase 1: normal providers (in-scope)
        │     tsgo/tsc LSP   → respects tsconfig include
        │     sourcekit-lsp  → respects Package.swift targets
        │     biome/oxlint    → always checks what you pass
        │
        └─ Phase 2: out-of-scope fallback (if Phase 1 returned nothing)
              tsc-direct     → tsc --noEmit --strict <file>  (bypasses tsconfig)
              clang-direct   → clang -fsyntax-only <file>    (no compile_commands needed)
              biome/oxlint    → already done in Phase 1 (these don't exclude)
```

### Per-provider fallback table

| Normal provider | Out-of-scope fallback | Notes |
|---|---|---|
| tsgo LSP | `tsc --noEmit --strict <file>` | Spawns inline; ~300-500ms |
| tsc spawn | `tsc --noEmit --strict <file>` | Already spawn-based; same path |
| sourcekit-lsp (Swift) | None needed | Already syntax-checks ad-hoc .swift files |
| sourcekit-lsp (C/ObjC/C++) | `clang -fsyntax-only <file>` | Bypasses need for compile_commands.json |
| biome | None needed | Always checks whatever file you pass |
| oxlint | None needed | Same |

Biome and oxlint are "always-scope" tools — they check whatever path you
hand them and don't have include/exclude concepts tied to project structure.
They run in Phase 1 and never need a fallback.

### Signaling the model

Out-of-scope findings are marked so the model can distinguish them from
normal project diagnostics:

**Finding level:** `scope: "ad-hoc"` field on each Finding.

**Note level:** `[ad-hoc]` prefix in the formatted note line:

```
[ad-hoc] 35:12 error TS2532 possibly undefined
```

**Annotation level:** `scope="ad-hoc"` attribute on the model-facing block:

```
<ma::agent::diagnostics count="3" scope="ad-hoc">
[ad-hoc] 35:12 error TS2532 Object is possibly 'undefined'.
[ad-hoc] 67:13 error TS2532 Object is possibly 'undefined'.
[ad-hoc] 71:42 error TS2345 Argument of type 'number | undefined'.
</ma::agent::diagnostics>
```

Without the signal, a model seeing these errors might try to "fix" a file
that was deliberately placed outside project scope. With it, the model knows
these are harness-provided hints, not the project's own enforced rules.

### Config

```jsonc
"plugins": {
  "diagnostics": {
    "outOfScope": {
      "enabled": true   // default: check excluded files with direct fallback
    }
  }
}
```

Set `outOfScope.enabled: false` to disable and respect project exclusions
completely. This gives the user an explicit opt-out if ad-hoc files are
intentionally noisy.

### Scope detection: how the plugin knows a file is out-of-scope

The `inScopeForTs()` helper reads the nearest `tsconfig.json` and checks
the file against `include`/`exclude`/`files` globs. Providers that support
it expose an optional `inScope(path)` method; the service consults it
before deciding to run the fallback.

For languages without explicit project manifests (loose `.swift` files,
standalone `.c`), the check is simpler: if `findProjectRoot` returns null
(no Package.swift, no .xcodeproj, no compile_commands.json), the file is
out of scope and the direct fallback applies.

### Future: clang-direct provider

C, C++, and Objective-C files currently get no diagnostics without a
`compile_commands.json` (clangd requirement). A `clang -fsyntax-only`
direct provider would give basic syntax checking for ad-hoc C-family files
without needing an Xcode project or build system. The `sourcekit-lsp`
persistent LSP handles the in-project case; `clang-direct` would be the
out-of-scope fallback.
