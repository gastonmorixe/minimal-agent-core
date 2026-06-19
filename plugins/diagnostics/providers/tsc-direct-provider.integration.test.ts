import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { TscDirectProvider } from "./tsc-direct-provider.ts"

const REPO = join(import.meta.dir, "..", "..", "..")
const tscBin = join(REPO, "node_modules", ".bin", "tsc")

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "diag-tsc-direct-"))
}

describe("TscDirectProvider (real tsc)", () => {
  it.skipIf(!existsSync(tscBin))(
    "checks a single file directly, bypassing tsconfig, and tags scope:ad-hoc",
    async () => {
      const dir = scratchDir()
      const file = join(dir, "standalone.ts")
      writeFileSync(file, `const x: number = "not a number"\n`)
      try {
        const p = new TscDirectProvider(tscBin, dir)
        const findings = await p.check(file, "")
        expect(findings.length).toBeGreaterThan(0)
        expect(findings.some((f) => f.code === "TS2322")).toBe(true)
        expect(findings.every((f) => f.scope === "ad-hoc")).toBe(true)
        expect(findings.every((f) => f.source === "tsc-direct")).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )

  it.skipIf(!existsSync(tscBin))(
    "returns empty for a clean file",
    async () => {
      const dir = scratchDir()
      const file = join(dir, "clean.ts")
      writeFileSync(file, `const x: number = 42\n`)
      try {
        const p = new TscDirectProvider(tscBin, dir)
        expect(await p.check(file, "")).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    30000,
  )
})
