/**
 * Architecture ratchet: every production source under `src/sdk/` must remain
 * independent of concrete host, plugin, terminal, mode, session, and status
 * implementations. SDK code speaks through ports instead.
 *
 * The scanner uses the TypeScript Compiler API AST plus lexical binding scopes,
 * so docs, comments, strings, regexes, and shadowed globals cannot create false failures.
 *
 * @module architecture/sdk-port-boundaries.test
 */

import { describe, expect, it } from "bun:test"

import {
  forbiddenSdkImports,
  formatSdkViolations,
  scanSdkPortBoundaries,
  scanSdkSource,
  sdkSourceFilesUnder,
  typeOnlySdkImportCount,
} from "./sdk-port-boundaries-scan.ts"

const SDK_ROOT = "src/sdk"

// Construct fixture specifiers at runtime so the older raw-source core→host
// scanner does not treat this test's deliberately forbidden fixture code as a
// production import. The source passed to `scanSdkSource` still contains the
// genuine static literal forms asserted below.
const parentSpecifier = ["..", "/"].join("")
const hostSpecifier = `${parentSpecifier}host/host.ts`
const pluginSpecifier = `${parentSpecifier}plugins/loader.ts`
const modeSpecifier = `${parentSpecifier}modes/modes.ts`
const sessionSpecifier = `${parentSpecifier}session/session-store.ts`
const uiSpecifier = `${parentSpecifier}ui/compositor.ts`

describe("SDK port boundaries scanner", () => {
  it("finds every literal module-edge form and classifies type-only imports", () => {
    const source = [
      `import type { Host } from "${hostSpecifier}"`,
      `import { loader } from "${pluginSpecifier}"`,
      `export type { Mode } from "${modeSpecifier}"`,
      `void import("${sessionSpecifier}")`,
      `require("${uiSpecifier}")`,
      'import type { Message } from "../llm/messages.ts"',
      'import "../llm/register-defaults.ts"',
    ].join("\n")
    // These assertions make the fixture's final scanned value explicit without
    // exposing a raw host-edge fixture to the older repository scanner.
    expect(source).toContain(`import type { Host } from "${hostSpecifier}"`)
    expect(source).toContain(`export type { Mode } from "${modeSpecifier}"`)
    expect(source).toContain(`void import("${sessionSpecifier}")`)
    expect(source).toContain(`require("${uiSpecifier}")`)

    const result = scanSdkSource(source, "unit.ts")

    expect(result.imports).toEqual([
      expect.objectContaining({ form: "import", specifier: "../host/host.ts", typeOnly: true }),
      expect.objectContaining({
        form: "import",
        specifier: "../plugins/loader.ts",
        typeOnly: false,
      }),
      expect.objectContaining({
        form: "export-from",
        specifier: "../modes/modes.ts",
        typeOnly: true,
      }),
      expect.objectContaining({ form: "dynamic-import", specifier: "../session/session-store.ts" }),
      expect.objectContaining({ form: "require", specifier: "../ui/compositor.ts" }),
      expect.objectContaining({ form: "import", specifier: "../llm/messages.ts", typeOnly: true }),
      expect.objectContaining({
        form: "import",
        specifier: "../llm/register-defaults.ts",
        typeOnly: false,
      }),
    ])
    expect(forbiddenSdkImports(result)).toHaveLength(5)
    expect(typeOnlySdkImportCount(result)).toBe(3)
  })

  it("rejects computed dynamic imports because their targets cannot be classified", () => {
    const result = scanSdkSource(
      `const target = "${hostSpecifier}"\nvoid import(target)`,
      "unit.ts",
    )

    expect(result.computedDynamicImports).toEqual([
      expect.objectContaining({
        token: "import()",
        detail: expect.stringContaining("cannot be classified"),
      }),
    ])
  })

  it("rejects local absolute paths and file URLs as unclassifiable", () => {
    const result = scanSdkSource(
      [
        'import "/repo/src/host/host.ts"',
        'export * from "file:///repo/src/plugins/loader.ts"',
        'void import("C:\\\\repo\\\\src\\\\ui\\\\compositor.ts")',
        'require("\\\\\\\\server\\\\repo\\\\src\\\\host\\\\host.ts")',
      ].join("\n"),
      "unit.ts",
    )

    expect(result.imports).toEqual([])
    expect(result.computedDynamicImports).toHaveLength(4)
    expect(result.computedDynamicImports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: "module specifier",
          detail: expect.stringContaining("without repository-root context"),
        }),
      ]),
    )
  })

  it("allows package and node builtin specifiers", () => {
    const result = scanSdkSource(
      ['import "package-name"', 'import "@scope/package/subpath"', 'import "node:path"'].join("\n"),
      "unit.ts",
    )

    expect(result.imports.map((site) => site.specifier)).toEqual([
      "package-name",
      "@scope/package/subpath",
      "node:path",
    ])
    expect(result.computedDynamicImports).toEqual([])
  })

  it("fails clearly when the configured Node executable is unavailable", () => {
    const previous = process.env.NODE
    process.env.NODE = "definitely-not-a-node-executable"
    try {
      expect(() => scanSdkSource("export {}", "unit.ts")).toThrow(
        /requires a Node executable with built-in TypeScript support.*Set NODE/u,
      )
    } finally {
      if (previous === undefined) delete process.env.NODE
      else process.env.NODE = previous
    }
  })

  it("rejects Bun when NODE points at a runtime that impersonates Node globals", () => {
    const previous = process.env.NODE
    process.env.NODE = process.execPath
    try {
      expect(() => scanSdkSource("export {}", "unit.ts")).toThrow(
        /requires a Node executable with built-in TypeScript support.*genuine Node/u,
      )
    } finally {
      if (previous === undefined) delete process.env.NODE
      else process.env.NODE = previous
    }
  })

  it("detects a ternary literal dynamic import", () => {
    const result = scanSdkSource(`cond ? import("${hostSpecifier}") : null`, "unit.ts")

    expect(result.imports).toEqual([
      expect.objectContaining({ form: "dynamic-import", specifier: "../host/host.ts" }),
    ])
  })

  it("does not misclassify property access as a dynamic import", () => {
    const result = scanSdkSource(
      `obj.import("${hostSpecifier}")\nobj?.import("${hostSpecifier}")`,
      "unit.ts",
    )

    expect(result.imports).toEqual([])
    expect(result.computedDynamicImports).toEqual([])
  })

  it("classifies bare optional-call require but not property or resolve access", () => {
    const literal = scanSdkSource(`require?.("${hostSpecifier}")`, "unit.ts")
    const computed = scanSdkSource("require?.(target)", "unit.ts")
    const clean = scanSdkSource(
      `obj.require("${hostSpecifier}")\nobj?.require("${hostSpecifier}")\nrequire.resolve("x")`,
      "unit.ts",
    )

    expect(literal.imports).toEqual([
      expect.objectContaining({ form: "require", specifier: "../host/host.ts" }),
    ])
    expect(computed.computedDynamicImports).toEqual([
      expect.objectContaining({
        token: "require()",
        detail: expect.stringContaining("cannot be classified"),
      }),
    ])
    expect(clean.imports).toEqual([])
    expect(clean.computedDynamicImports).toEqual([])
  })

  it("flags every bare executable process use", () => {
    const result = scanSdkSource(
      [
        "const alias = process",
        "consume(process)",
        "typeof process",
        'process?.["env"]',
        "process",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.ambientEscapes.map((site) => site.token)).toEqual([
      "process",
      "process",
      "process",
      "process.env",
      "process",
    ])
  })

  it("detects all executable process access and ambient output escapes", () => {
    const result = scanSdkSource(
      [
        "process.env.SDK_FLAG",
        "process.cwd()",
        "process.stdin.resume()",
        "process.stdout.write('x')",
        "process.stderr.write('x')",
        "process.argv",
        "process?.env.OPTIONAL",
        'process["env"].COMPUTED',
        "process?.cwd()",
        "process['stdout'].write('x')",
        "Bun.stdin.stream()",
        "Bun.stdout.write('x')",
        "Bun.stderr.write('x')",
        "console.log('x')",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.ambientEscapes.map((site) => site.token)).toEqual([
      "process.env",
      "process.cwd",
      "process.stdin",
      "process.stdout",
      "process.stderr",
      "process.argv",
      "process.env",
      "process.env",
      "process.cwd",
      "process.stdout",
      "Bun.stdin",
      "Bun.stdout",
      "Bun.stderr",
      "console.log",
    ])
  })

  it("scans executable code after nested braces inside template interpolations", () => {
    const result = scanSdkSource(
      [
        "const functionNested = `${(() => {})(), process.env.AFTER}`",
        'const objectNested = `${({ a: 1 }), process.stdout.write("x")}`',
      ].join("\n"),
      "unit.ts",
    )

    expect(result.ambientEscapes.map((site) => site.token)).toEqual([
      "process.env",
      "process.stdout",
    ])
  })

  it("keeps clean nested-brace template interpolations clean", () => {
    const result = scanSdkSource(
      "const clean = `${(() => ({ nested: { value: 1 } }))()}`",
      "unit.ts",
    )

    expect(result.imports).toEqual([])
    expect(result.computedDynamicImports).toEqual([])
    expect(result.ambientEscapes).toEqual([])
  })

  it("detects optional and computed Bun and console output escapes", () => {
    const result = scanSdkSource(
      [
        "Bun?.stdout.write('x')",
        'Bun["stdout"].write("x")',
        'Bun?.["stdout"].write("x")',
        "console?.log('x')",
        'console["log"]("x")',
        'console?.["log"]("x")',
      ].join("\n"),
      "unit.ts",
    )

    expect(result.ambientEscapes.map((site) => site.token)).toEqual([
      "Bun.stdout",
      "Bun.stdout",
      "Bun.stdout",
      "console.log",
      "console.log",
      "console.log",
    ])
  })

  it("ignores property names and non-executable ambient-lookalikes", () => {
    const result = scanSdkSource(
      [
        "obj.process",
        "obj.Bun",
        "obj.console",
        'const text = "process Bun.stdout console.log"',
        "const template = `process Bun.stdout console.log`",
        String.raw`const regex = /process|Bun\.stdout|console\.log/`,
        "// process Bun.stdout console.log",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.ambientEscapes).toEqual([])
  })

  it("ignores ambient-lookalike names in member declarations and labels", () => {
    const result = scanSdkSource(
      [
        "interface Members { process: string; Bun: number; console: boolean }",
        "interface Methods { process(): void; Bun(): void; console(): void }",
        "type Shape = { process: string; Bun: number; console: boolean }",
        "class Fields { process = 1; Bun = 2; console = 3 }",
        "class Methods { process() {} Bun() {} console() {} }",
        "class Accessors { get process() { return 1 } set process(v: number) {} get Bun() { return 1 } set Bun(v: number) {} get console() { return 1 } set console(v: number) {} }",
        "enum Tokens { process, Bun, console }",
        "namespace process { export const x = 1 }",
        "process: while (true) { consume(1) }",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.ambientEscapes).toEqual([])
  })

  it("still flags shorthand property assignments as real value references", () => {
    const result = scanSdkSource("const obj = { process }", "unit.ts")

    expect(result.ambientEscapes.map((site) => site.token)).toEqual(["process"])
  })

  it("masks regex literals after expression prefixes and still scans after division", () => {
    const result = scanSdkSource(
      [
        "function f() { return /process.env/ }",
        "throw /process.env/",
        "case /process.env/: break",
        "function* generator() { yield /process.env/ }",
        "const arrow = () => /process.env/",
        "const quotient = value / divisor; process.env.AFTER_DIVISION",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.imports).toEqual([])
    expect(result.computedDynamicImports).toEqual([])
    expect(result.ambientEscapes).toEqual([expect.objectContaining({ token: "process.env" })])
  })

  it("masks regex expression statements after nested control headers, not calls or grouping", () => {
    const result = scanSdkSource(
      [
        "if (ok) /process.env/",
        "while (ok) /process.env/",
        "for (;;) /process.env/",
        "catch (error) /process.env/",
        "if ((ok)) /process.env/",
        "const quotient = (value) / divisor; process.env.AFTER_GROUPING",
        "call(value) / divisor; process.env.AFTER_CALL",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.imports).toEqual([])
    expect(result.computedDynamicImports).toEqual([])
    expect(result.ambientEscapes).toEqual([
      expect.objectContaining({ token: "process.env" }),
      expect.objectContaining({ token: "process.env" }),
    ])
  })

  it("ignores regex literals containing forbidden-looking tokens", () => {
    const result = scanSdkSource(
      String.raw`const pattern = /process.env|require("..\\/host\\/host.ts")|import("..\\/host\\/host.ts")/`,
      "unit.ts",
    )

    expect(result.imports).toEqual([])
    expect(result.computedDynamicImports).toEqual([])
    expect(result.ambientEscapes).toEqual([])
  })

  it("handles computed loaders, explicit globals, unicode escapes, and lexical shadowing", () => {
    const result = scanSdkSource(
      [
        `globalThis["require"]("${hostSpecifier}")`,
        `global["require"](target)`,
        "globalThis.process.env.SDK_FLAG",
        'global["Bun"]["stdout"].write("x")',
        'globalThis["console"]["log"]("x")',
        String.raw`pr\u006fcess.cwd()`,
        "function clean(process: unknown, require: (x: string) => unknown, Bun: unknown, console: unknown) {",
        `  require("${hostSpecifier}"); void process; void Bun; void console`,
        "}",
        "{ const process = localProcess; process.env; const require = localRequire; require(target) }",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.imports).toEqual([
      expect.objectContaining({ form: "require", specifier: "../host/host.ts" }),
    ])
    expect(result.computedDynamicImports).toEqual([expect.objectContaining({ token: "require()" })])
    expect(result.ambientEscapes.map((site) => site.token)).toEqual([
      "process.env",
      "Bun.stdout",
      "console.log",
      "process.cwd",
    ])
  })

  it("keeps loop initializer bindings scoped to each loop", () => {
    const result = scanSdkSource(
      [
        "for (let process = localProcess; condition; step()) process.env",
        "process.env.AFTER_FOR",
        "for (const Bun in bunValues) Bun.stdout",
        "Bun.stdout.write('after for-in')",
        "for (const console of consoles) console.log('local')",
        "console.log('after for-of')",
        `for (const require of loaders) require("${hostSpecifier}")`,
        `require("${hostSpecifier}")`,
      ].join("\n"),
      "unit.ts",
    )

    expect(result.imports).toEqual([
      expect.objectContaining({ form: "require", specifier: "../host/host.ts" }),
    ])
    expect(result.ambientEscapes.map((site) => site.token)).toEqual([
      "process.env",
      "Bun.stdout",
      "console.log",
    ])
  })

  it("classifies per-specifier type-only edges and keeps type-only bindings non-shadowing", () => {
    const result = scanSdkSource(
      [
        `import { type Host } from "${hostSpecifier}"`,
        `export { type Mode } from "${modeSpecifier}"`,
        'import { type process } from "./types.ts"',
        "process.env.SDK_FLAG",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.imports).toEqual([
      expect.objectContaining({ specifier: "../host/host.ts", typeOnly: true }),
      expect.objectContaining({ specifier: "../modes/modes.ts", typeOnly: true }),
      expect.objectContaining({ specifier: "./types.ts", typeOnly: true }),
    ])
    expect(result.ambientEscapes).toEqual([expect.objectContaining({ token: "process.env" })])
  })

  it("ignores comments, JSDoc, ordinary strings, and template text", () => {
    const result = scanSdkSource(
      [
        `/** process.env and import("${hostSpecifier}") are documentation. */`,
        '// console.log("not executable")',
        `const single = "process.stdout and require(\\"${uiSpecifier}\\")"`,
        `const double = 'Bun.stderr and import("${sessionSpecifier}")'`,
        `const template = \`process.cwd and import('${pluginSpecifier}')\``,
        "const visible = `${process.env.SDK_FLAG}`",
      ].join("\n"),
      "unit.ts",
    )

    expect(result.imports).toEqual([])
    expect(result.computedDynamicImports).toEqual([])
    expect(result.ambientEscapes).toEqual([expect.objectContaining({ token: "process.env" })])
  })

  it("scans every production SDK file with no skipped tests, fixtures, exceptions, or baseline", () => {
    const files = sdkSourceFilesUnder(SDK_ROOT)
    expect(files).not.toContain("agent-core.test.ts")
    expect(files).toContain("agent-core.ts")

    const result = scanSdkPortBoundaries(SDK_ROOT)
    const violations = formatSdkViolations(result)
    expect(violations, `SDK boundary violations:\n${violations.join("\n")}`).toEqual([])

    // Type-only edges are deliberately counted, not exempted. Keep this exact
    // inventory as a ratchet so additions require an intentional architecture review.
    // 29 -> 31 (S20): `Diagnostics` (src/diagnostics/hub.ts) threaded as a
    // type-only edge into `src/sdk/run-recovery.ts` and `src/sdk/lifecycle-compact.ts`,
    // the two sdk-owned call sites that now take the injected diagnostics handle.
    // 31 -> 46 (S17/S50): host-ports.ts, preflight-ask.ts, round-checkpoint.ts
    // and their type-only edges into agent-core.ts, agent-core-helpers.ts
    // (decoupled there to keep agent-core.ts under the max-lines gate), and
    // ports.ts. No new edge crosses a forbidden boundary (the `violations`
    // assertion above still passes empty).
    // 46 -> 61 (spec S18/S19/S23/S24/S28): new type-only imports of the new
    // ports (StatusFields/StatusPhase, StatusPort, ToolEnvPort,
    // PluginEventsPort) and the new sdk/ modules (event-filter.ts,
    // tool-facts.ts, tool-calls.ts) that carry the typed event contract and
    // the status/toolEnv/pluginEvents ports.
    // 61 -> 63 (S34 exports-gap, agent Y1): two new `src/sdk/` forwarding
    // shims (`messages.ts`, `provider.ts`) that publish `src/llm/messages.ts`
    // and `src/llm/provider.ts` under `./sdk/messages` / `./sdk/provider` so
    // `public-api.test.ts`'s target-path rule is satisfied. Both source
    // modules are pure types with zero runtime exports, so each shim is a
    // single `export type * from "..."` line — one new type-only edge each.
    // No forbidden boundary is crossed (the `violations` assertion above
    // stays empty); this only grows the documented inventory.
    // 63 -> 67 (ACP Phase 0, shared wire-event mapper): the new
    // `src/sdk/wire-events.ts` (pure projections of AgentEvent, for a future
    // ACP encoder; stream-json keeps consuming AgentEvent unchanged, see its
    // module doc) type-imports `TurnNotice` (../agent/turn-notice.ts),
    // `TurnOutcome` (./stop-policy.ts), and several AgentEvent member types
    // (./events.ts) — three type-only edges — and `events.ts` re-exports its
    // public types with one `export type { ... } from "./wire-events.ts"` —
    // a fourth. No forbidden boundary is crossed (the `violations` assertion
    // above stays empty); this only grows the documented inventory.
    // 67 -> 66 (decision 28): `src/sdk/print-mode.ts` moved to the CLI. Its
    // type-only import of `AgentEvent` / `StatusEvent` (./events.ts) is gone.
    // 66 -> 67 (S3.1): `src/sdk/ports.ts` imports the type-only
    // `SyntheticTextProvider` from plugin-api for `AgentCoreConfig`.
    // 67 -> 68 (S3.1 G2): `src/sdk/ports.ts` imports the type-only
    // `TurnContentProviderDecl` from plugin-api for `AgentCoreConfig`.
    // 68 -> 83 (anytime target switching): `src/sdk/target-switch.ts` (pure
    // resolver: model-registry, effort-resolution, transport types, agent
    // turn-notice), `src/sdk/target-credential-names.ts` (no imports),
    // `src/sdk/send-attempt.ts` (transport seam: cache, reflection,
    // auth/bus/cache/llm/network/ports/events/run-output-strict/run-temperature/
    // output-config/agent-core-helpers), `src/sdk/run-options.ts` (preflight
    // ask, events, transport types), and the `agent-core.ts` rewiring
    // (target-switch, target-credential-names, send-attempt). No forbidden
    // boundary is crossed; this only grows the documented inventory.
    // 83 -> 84 (S5.2): `src/sdk/ports.ts` imports the type-only
    // `SystemPromptBaseHolder` for the `PromptContributor` port. No forbidden
    // boundary is crossed.
    // 84 -> 85 (ACP provider switch): `src/sdk/target-switch.ts` imports the
    // type-only `AuthResult` for `TargetSelection.auth`. `agent-core.ts`
    // already has the same edge. No forbidden boundary is crossed.
    // 85 -> 92 (hook seams part 2): `src/sdk/turn-stop-hook.ts` (ContentBlock,
    // StreamedResponse, LifecyclePort), `src/sdk/session-context.ts`
    // (ContentBlock), `src/sdk/agent-core-helpers.ts` (CacheTtl,
    // SystemPromptOverrides, for buildTurnSystemPrompt), and `agent-core.ts`,
    // whose transport-types import became type-only when the system prompt
    // build moved to agent-core-helpers.ts. No forbidden boundary is crossed.
    // 92 -> 94 (task A review M1): `src/sdk/host-facts.ts` (new) and
    // `src/sdk/turn-stop-hook.ts` import the type-only `SessionFacts`
    // (./ports.ts). They replace the `src/agent/session-facts.ts` shim that
    // read src/session and the process. No forbidden boundary is crossed
    // (see sdk-transitive.test.ts).
    // 94 -> 96 (hook context positions): `src/sdk/agent-core-helpers.ts`
    // imports the type-only `HookContextEntry` (./hook-context.ts), and the
    // `agent-core.ts` import of ./hook-context.ts became type-only when the
    // first message assembly moved to session-context.ts. No forbidden
    // boundary is crossed.
    // 96 -> 97 (P1 review F4): `src/sdk/host-facts.ts` imports the type-only
    // `HookContextEntry` (./hook-context.ts) to type the `compactSessionFacts`
    // sink. No forbidden boundary is crossed.
    // 97 -> 98 (P1 review F1): `src/sdk/hook-context.ts` imports the type-only
    // `HookContextEntry` from plugin-api, its one source of truth, so plugins
    // get it from `@minimal-agent/core/plugin-api/types/plugin`. Same pattern
    // as the ports.ts plugin-api edges. No forbidden boundary is crossed.
    // +1 (zero-prompts P1.2): `src/sdk/ports.ts` imports the type-only
    // `ToolTextProvider` (plugin-api/src/types/tool-text.ts) for
    // `AgentCoreConfig.toolTextProviders`, next to `SyntheticTextProvider`.
    // plugin-api is a leaf contract package. No forbidden boundary is crossed.
    // +1 (zero-prompts P1.5): `src/sdk/agent-core-helpers.ts` imports
    // the type-only `SyntheticTextResolver` (src/agent/synthetic-text.ts) to
    // pass the core's one resolver to the runtime markers and the media
    // resolver. agent-core.ts already has the same edge. No forbidden
    // boundary is crossed.
    // +1 (zero-prompts P3.7): `src/sdk/turn-stop-hook.ts` imports the
    // type-only `SyntheticTextResolver` for the `runtime.hook_denied` text
    // (the default reason of a halt with no reason). Same edge as above.
    // +8 (agent-core split, pure move): `src/sdk/agent-core-round.ts`
    // type-imports llm/messages, diagnostics/hub, llm/transport/types,
    // ./events, ./hook-context, ./ports, ./send-attempt and ./session-context
    // with normal `import type` statements (review W1: no `import()` alias
    // block that hides edges from this count). No forbidden boundary is
    // crossed.
    // +2 (zero-prompts 15a): `src/sdk/continuation.ts` (the continuation
    // messages, moved out of agent-core.ts for its max-lines budget)
    // type-imports `SyntheticTextResolver` (src/agent/synthetic-text.ts) and
    // `ContentBlock` (llm/messages). agent-core.ts has the same edges. No
    // forbidden boundary is crossed.
    // +1 (15a review W1): `src/sdk/continuation.ts` type-imports `Diagnostics`
    // (src/diagnostics/hub.ts) for the `continuation.no_text` warning.
    // agent-core.ts already imports it. No forbidden boundary is crossed.
    // +3 (N1/N5): `src/sdk/drain-pending-compact.ts` (the queued-compact
    // drain, moved out of agent-core.ts for its max-lines budget) type-imports
    // `CompactRequestOpts`/`CompactStats` (agent/context-compact), `Diagnostics`
    // (diagnostics/hub) and `HostPorts` (./host-ports). agent-core.ts has the
    // same edges. No forbidden boundary is crossed.
    // +1 (zero-prompts 15d.3a): `src/sdk/lifecycle-compact.ts` type-imports
    // `SyntheticTextResolverLike` (./ports) for the `text` field it forwards
    // to `runCompact`. Same-directory SDK port type. No forbidden boundary is
    // crossed.
    expect(typeOnlySdkImportCount(result)).toBe(116)
  })
})
