/**
 * Integration tests for the spawn-based providers against the REAL binaries in
 * this repo (biome, oxlint). These prove the spawn → adapt → Finding pipeline
 * with the actual tools, not mocks. Skipped automatically when a binary is
 * absent so the suite stays green in minimal environments.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { BiomeProvider } from "./biome-provider.ts"
import { OxlintProvider } from "./oxlint-provider.ts"

const REPO = join(import.meta.dir, "..", "..", "..")
const biomeBin = join(REPO, "node_modules", ".bin", "biome")
const oxlintBin = join(REPO, "node_modules", ".bin", "oxlint")

describe("BiomeProvider (real binary)", () => {
  it.skipIf(!existsSync(biomeBin))("flags a badly formatted file on disk", async () => {
    const { writeFileSync, rmSync } = await import("node:fs")
    const probe = join(REPO, "src", "__diag_probe_biome.ts")
    // semicolons violate the repo biome config (asNeeded) → a `format` finding.
    writeFileSync(probe, "const x = 1;\nconst y = 2;\n")
    try {
      const p = new BiomeProvider(biomeBin, REPO)
      const findings = await p.check(probe, "const x = 1;\nconst y = 2;\n")
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.every((f) => f.source === "biome")).toBe(true)
    } finally {
      rmSync(probe, { force: true })
    }
  })

  it.skipIf(!existsSync(biomeBin))("returns [] for clean, well-formatted code", async () => {
    const { writeFileSync, rmSync } = await import("node:fs")
    const probe = join(REPO, "src", "__diag_probe_biome_clean.ts")
    writeFileSync(probe, "const x = 1\n")
    try {
      const p = new BiomeProvider(biomeBin, REPO)
      const findings = await p.check(probe, "const x = 1\n")
      expect(findings).toEqual([])
    } finally {
      rmSync(probe, { force: true })
    }
  })
})

describe("OxlintProvider (real binary)", () => {
  it.skipIf(!existsSync(oxlintBin))("flags a real lint violation on a written file", async () => {
    const { writeFileSync, rmSync } = await import("node:fs")
    const probe = join(REPO, "src", "__diag_probe_oxlint.ts")
    writeFileSync(probe, "debugger\nexport {}\n")
    try {
      const p = new OxlintProvider(oxlintBin, REPO)
      const findings = await p.check(probe, "debugger\nexport {}\n")
      expect(findings.length).toBeGreaterThan(0)
      expect(findings.some((f) => /no-debugger/.test(f.code ?? ""))).toBe(true)
    } finally {
      rmSync(probe, { force: true })
    }
  })
})
