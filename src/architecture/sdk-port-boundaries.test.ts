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
    expect(typeOnlySdkImportCount(result)).toBe(32)
  })
})
