/**
 * S0.5 claim (b): who writes the `interactive_result` synthetic user message?
 * Finding: nobody. The kind exists only as a type variant and a doc comment in
 * plugin-api. No core runtime code produces a user message from it. This test
 * pins that fact (source-level) and pins the doc text.
 *
 * @module sdk/s05-claim-b-interactive-result.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

const CORE_ROOT = join(import.meta.dir, "..", "..")

function isProduction(path: string): boolean {
  return !/\.(test|e2e\.test|fixtures?)\.ts$/.test(path) && !path.includes("node_modules")
}

function scan(dir: string): string[] {
  const hits: string[] = []
  const glob = new Bun.Glob("**/*.ts")
  for (const rel of glob.scanSync({ cwd: join(CORE_ROOT, dir) })) {
    if (!isProduction(rel)) continue
    const text = readFileSync(join(CORE_ROOT, dir, rel), "utf8")
    if (text.includes("interactive_result")) hits.push(join(dir, rel))
  }
  return hits
}

describe("S0.5 claim b: interactive_result has no producer in core", () => {
  it("appears only in plugin-api/src/types/plugin.ts, never in src/", () => {
    expect(scan("src")).toEqual([])
    expect(scan("plugin-api")).toEqual([join("plugin-api", "src", "types", "plugin.ts")])
  })

  it("plugin.ts holds only the type variant and the doc comment", () => {
    const text = readFileSync(join(CORE_ROOT, "plugin-api/src/types/plugin.ts"), "utf8")
    const lines = text.split("\n").filter((l) => l.includes("interactive_result"))
    expect(lines.length).toBe(2)
    expect(lines.some((l) => l.includes('{ kind: "interactive_result"; value: unknown }'))).toBe(
      true,
    )
    expect(text).toContain(
      "the value is\n *   JSON-encoded and injected as a synthetic user message after the\n *   truncated assistant turn.",
    )
  })
})
