/**
 * Architecture fitness function: the public closure (spec S32).
 *
 * THE RATCHET: walk every edge from each public entry in the package
 * `exports` map (static, dynamic, type-only, and type-position `import()`).
 * No reached file may
 *   1. sit under `cli`, `host`, `ui`, `terminal`, or `input`,
 *   2. use `process.stdin`, `process.stdout`, `process.stderr` (or the Bun
 *      streams, or `console` output),
 *   3. hold an ANSI escape literal,
 * beyond its entry in `PUBLIC_CLOSURE_BASELINE` (`public-closure-scan.ts`).
 * The check runs both ways, so the baseline only shrinks until S44:
 *
 *   - A new finding, or a count above its entry, FAILS. The message shows
 *     the import chain from the entry.
 *   - A count below its entry, or a clean file that still has one, FAILS:
 *     lower or remove the entry.
 *
 * The consumer smoke test from v1 S32 (`consumer-smoke.test.ts`) is not
 * here: it drove `openConversation` / `runTask`, which spec v2 removed. S47
 * writes it against `createRuntime` / `openSession`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import {
  type ClosureFinding,
  chainTo,
  PUBLIC_CLOSURE_BASELINE,
  resolveCoreEdge,
  walkPublicClosure,
} from "./public-closure-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const CLEAN: ClosureFinding = { cliFile: false, stdio: 0, ansi: 0 }

// Built at runtime so the raw-source core-to-host scanner does not read this
// fixture text as a production import of the host.
const HOST_SPECIFIER = ["..", "host", "repl.ts"].join("/")

describe("walkPublicClosure (fixture tree)", () => {
  const root = mkdtempSync(join(tmpdir(), "public-closure-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  write(
    "src/sdk/entry.ts",
    [
      `import { a } from "../llm/static.ts"`,
      `import type { B } from "../llm/type-only.ts"`,
      `export * from "../llm/reexport.ts"`,
      `export type Q = import("../llm/type-position.ts").Q`,
      `export async function load() { return import("../llm/dynamic.ts") }`,
      `import { u } from "@minimal-agent/core/plugin-api/utils/ui"`,
      `import { join } from "node:path"`,
      `// import "../llm/in-comment.ts"`,
      `const s = 'import "../llm/in-string.ts"'`,
    ].join("\n"),
  )
  write("src/llm/static.ts", `export const a = 1\n`)
  write("src/llm/type-only.ts", `export type B = 1\n`)
  write("src/llm/reexport.ts", `export { c } from "./chained.ts"\n`)
  write("src/llm/chained.ts", `export const c = process.stdout.columns\n`)
  write("src/llm/type-position.ts", `export type Q = 1\n`)
  write("src/llm/dynamic.ts", `import "${HOST_SPECIFIER}"\nimport "../llm/moving.ts"\n`)
  write("src/host/repl.ts", `console.log("x")\n`)
  write("src/llm/moving.ts", `export {}\n`)
  write("src/llm/in-comment.ts", `export {}\n`)
  write("src/llm/in-string.ts", `export {}\n`)
  write("src/llm/unreached.ts", `process.stderr.write("x")\n`)
  write("plugin-api/src/utils/ui.ts", `export const u = "\\x1b[2m"\nimport "./missing.ts"\n`)
  const exportsMap = {
    "./sdk/entry": "./src/sdk/entry.ts",
    "./plugin-api/utils/ui": "./plugin-api/src/utils/ui.ts",
    "./package.json": "./package.json",
  }
  const closure = walkPublicClosure(root, { exportsMap })

  it("follows static, type-only, re-export, type-position, dynamic, and self-import edges", () => {
    expect(closure.entries).toEqual(["plugin-api/src/utils/ui.ts", "src/sdk/entry.ts"])
    expect(closure.reached).toEqual([
      "plugin-api/src/utils/ui.ts",
      "src/host/repl.ts",
      "src/llm/chained.ts",
      "src/llm/dynamic.ts",
      "src/llm/moving.ts",
      "src/llm/reexport.ts",
      "src/llm/static.ts",
      "src/llm/type-only.ts",
      "src/llm/type-position.ts",
      "src/sdk/entry.ts",
    ])
  })

  it("applies the three rules to each reached file", () => {
    expect(Object.fromEntries(closure.findings)).toEqual({
      "plugin-api/src/utils/ui.ts": { cliFile: false, stdio: 0, ansi: 1 },
      "src/host/repl.ts": { cliFile: true, stdio: 1, ansi: 0 },
      "src/llm/chained.ts": { cliFile: false, stdio: 1, ansi: 0 },
    })
  })

  it("reports core edges that resolve to no file, and the chain to a file", () => {
    expect(closure.unresolved).toEqual(["plugin-api/src/utils/ui.ts: ./missing.ts"])
    expect(chainTo(closure, "src/host/repl.ts")).toEqual([
      "src/sdk/entry.ts",
      "src/llm/dynamic.ts",
      "src/host/repl.ts",
    ])
  })

  it("does not follow builtins, packages, or unknown core subpaths", () => {
    expect(resolveCoreEdge(root, "src/sdk/entry.ts", "node:path", exportsMap)).toBeNull()
    expect(resolveCoreEdge(root, "src/sdk/entry.ts", "some-package", exportsMap)).toBeNull()
    expect(
      resolveCoreEdge(root, "src/sdk/entry.ts", "@minimal-agent/core/nope", exportsMap),
    ).toBeUndefined()
    expect(resolveCoreEdge(root, "src/sdk/entry.ts", "../llm/static", exportsMap)).toBe(
      "src/llm/static.ts",
    )
  })
})

describe("public closure (repo ratchet)", () => {
  const closure = walkPublicClosure(REPO_ROOT)

  it("every public entry and every core edge resolves", () => {
    expect(closure.entries).toContain("src/sdk/agent-core.ts")
    expect(closure.unresolved).toEqual([])
  })

  it("no reached file breaks a rule beyond its baseline entry", () => {
    const regressions: string[] = []
    for (const [file, actual] of closure.findings) {
      const allowed = PUBLIC_CLOSURE_BASELINE.get(file) ?? CLEAN
      const worse: string[] = []
      if (actual.cliFile && !allowed.cliFile) worse.push("CLI-side file")
      if (actual.stdio > allowed.stdio) worse.push(`stdio ${actual.stdio} > ${allowed.stdio}`)
      if (actual.ansi > allowed.ansi) worse.push(`ansi ${actual.ansi} > ${allowed.ansi}`)
      if (worse.length > 0) {
        regressions.push(
          `  ${file}: ${worse.join(", ")}\n    via ${chainTo(closure, file).join(" -> ")}`,
        )
      }
    }
    expect(
      regressions,
      regressions.length > 0
        ? "The public entries reach new CLI, stdio, or ANSI code. Cut the edge or\n" +
            "move the code behind a port:\n" +
            regressions.join("\n")
        : "",
    ).toEqual([])
  })

  it("the baseline has no stale entries (it only shrinks)", () => {
    const stale: string[] = []
    for (const [file, allowed] of PUBLIC_CLOSURE_BASELINE) {
      const actual = closure.findings.get(file) ?? CLEAN
      if (
        (allowed.cliFile && !actual.cliFile) ||
        actual.stdio < allowed.stdio ||
        actual.ansi < allowed.ansi
      ) {
        stale.push(
          `  ${file}: baseline ${JSON.stringify({ ...allowed, reason: undefined })}, actual ${JSON.stringify(actual)}`,
        )
      }
      if (allowed.reason.trim() === "") stale.push(`  ${file}: empty reason`)
    }
    expect(
      stale,
      stale.length > 0 ? "Lower or remove these baseline entries:\n" + stale.join("\n") : "",
    ).toEqual([])
  })
})
