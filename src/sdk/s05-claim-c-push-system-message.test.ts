/**
 * S0.5 claim (c): `pushSystemMessage` has no caller. Source-level scan of
 * core (production files), plus the sibling repos when they are present.
 *
 * @module sdk/s05-claim-c-push-system-message.test
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

const CORE_ROOT = join(import.meta.dir, "..", "..")
const SIBLINGS = ["minimal-agent-plugins", "minimal-agent-cli", "minimal-agent-web"]

function callers(root: string, dir: string): string[] {
  const hits: string[] = []
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  for (const rel of glob.scanSync({ cwd: join(root, dir) })) {
    if (/node_modules|\/private\/|\.test\.tsx?$/.test(`/${rel}`)) continue
    const lines = readFileSync(join(root, dir, rel), "utf8").split("\n")
    lines.forEach((l, i) => {
      if (l.includes("pushSystemMessage")) hits.push(`${rel}:${i + 1}`)
    })
  }
  return hits.sort()
}

describe("S0.5 claim c: pushSystemMessage has no caller", () => {
  it("core: only the definition in src/sdk/agent-core.ts", () => {
    const hits = callers(CORE_ROOT, "src").concat(callers(CORE_ROOT, "plugin-api"))
    expect(hits.length).toBe(1)
    expect(hits[0]?.startsWith("sdk/agent-core.ts:")).toBe(true)
    const line = readFileSync(join(CORE_ROOT, "src/sdk/agent-core.ts"), "utf8")
      .split("\n")
      .find((l) => l.includes("pushSystemMessage"))
    expect(line?.trim()).toBe("pushSystemMessage(text: string): void {")
  })

  for (const repo of SIBLINGS) {
    const root = join(CORE_ROOT, "..", repo)
    it.skipIf(!existsSync(root))(`${repo}: zero references`, () => {
      expect(callers(root, ".")).toEqual([])
    })
  }
})
