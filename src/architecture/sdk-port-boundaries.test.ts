/**
 * Architecture ratchet: SDK port boundaries.
 *
 * Enforces that the SDK port interfaces in `src/sdk/ports.ts` remain free of
 * concrete CLI/TUI/plugin dependencies. The ports are structural interfaces;
 * they must never import from `ui/`, `agent/repl*`, `startup/`, `commands/`,
 * `plugins/loader.ts`, `editor-controller.ts`, `compositor.ts`, or reference
 * `process.stdin/stdout/stderr`.
 *
 * This is the Phase 1 ratchet. Phase 2 adds a ratchet that `src/sdk/agent-core.ts`
 * (once extracted) also obeys these boundaries.
 *
 * @module architecture/sdk-port-boundaries.test
 */

import { readFileSync } from "node:fs"

import { describe, expect, it } from "bun:test"

const PORTS_PATH = "src/sdk/ports.ts"

const FORBIDDEN_IMPORTS = [
  "ui/",
  "agent/repl",
  "startup/",
  "commands/",
  "plugins/loader",
  "editor-controller",
  "compositor",
  "RawInput",
  "Formatter",
  "Spinner",
]

const FORBIDDEN_GLOBALS = ["process.stdin", "process.stdout", "process.stderr", "process.argv"]

describe("SDK port boundaries", () => {
  const text = readFileSync(PORTS_PATH, "utf-8")

  it("ports.ts has no forbidden imports", () => {
    for (const forbidden of FORBIDDEN_IMPORTS) {
      // Match import specifiers containing the forbidden substring.
      const re = new RegExp(
        `from\\s+["'][^"']*${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"']*["']`,
      )
      expect(text).not.toMatch(re)
    }
  })

  it("ports.ts has no forbidden global references", () => {
    for (const forbidden of FORBIDDEN_GLOBALS) {
      expect(text).not.toContain(forbidden)
    }
  })

  it("ports.ts exports only interfaces and types (no runtime code)", () => {
    // The file should not contain class, function, or const declarations
    // that produce runtime values (imports are fine).
    const lines = text.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed === "") continue
      if (trimmed.startsWith("import ")) continue
      if (trimmed.startsWith("export interface ")) continue
      if (trimmed.startsWith("export type ")) continue
      if (trimmed.startsWith("interface ")) continue
      if (trimmed.startsWith("type ")) continue
      if (trimmed === "}" || trimmed === "};" || trimmed === "},") continue
      if (trimmed.startsWith("/*") || trimmed.startsWith("*")) continue
      // Allow the module doc comment opening
      if (trimmed === "/**") continue
      // Allow export { ... } re-exports (none expected, but safe)
      if (trimmed.startsWith("export {")) continue
      // Fail on any other export or declaration
      if (
        trimmed.startsWith("export ") ||
        trimmed.startsWith("const ") ||
        trimmed.startsWith("let ") ||
        trimmed.startsWith("var ") ||
        trimmed.startsWith("function ") ||
        trimmed.startsWith("class ")
      ) {
        // This is a real failure — ports must be pure types.
        throw new Error(`SDK ports.ts contains runtime code: ${trimmed}`)
      }
    }
  })
})
