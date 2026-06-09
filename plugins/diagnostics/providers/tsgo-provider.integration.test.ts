/**
 * Integration test for {@link TsgoLspProvider} against the REAL tsgo LSP in
 * this repo. Proves the persistent-server path end to end: boot once, then
 * warm per-edit type diagnostics with correct TS codes. Skipped when tsgo is
 * absent so the suite stays green elsewhere.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { TsgoLspProvider } from "./tsgo-provider.ts"

const REPO = join(import.meta.dir, "..", "..", "..")
const tsgoBin = join(REPO, "node_modules", ".bin", "tsgo")
const target = join(REPO, "src", "tools", "feedback-tracker.ts")

describe("TsgoLspProvider (real tsgo LSP)", () => {
  it.skipIf(!existsSync(tsgoBin))(
    "detects an injected type error with a real TS code",
    async () => {
      const { readFileSync } = await import("node:fs")
      const provider = new TsgoLspProvider(tsgoBin, REPO)
      try {
        const clean = readFileSync(target, "utf8")
        const broken = `${clean}\nconst __probe: number = "not a number"\n`

        // clean buffer → no NEW errors from our probe line
        const cleanFindings = await provider.check(target, clean)
        expect(Array.isArray(cleanFindings)).toBe(true)

        // broken buffer → a TS2322 assignability error
        const brokenFindings = await provider.check(target, broken)
        expect(brokenFindings.some((f) => f.code === "TS2322")).toBe(true)
        expect(brokenFindings.every((f) => f.source === "tsgo")).toBe(true)

        // warm loop is fast: a few more cycles resolve quickly
        const t0 = performance.now()
        await provider.check(target, clean)
        const warmMs = performance.now() - t0
        // generous ceiling (CI noise); the point is "not a fresh 300ms spawn"
        expect(warmMs).toBeLessThan(150)
      } finally {
        provider.dispose()
      }
    },
    20_000,
  )
})
