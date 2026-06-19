/**
 * Tests for {@link DiagnosticsService} (composition root). Uses FAKE provider
 * factories so detection/wiring/filtering are tested without spawning. Runs
 * detection against a temp project fixture.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { DEFAULT_CONFIG, type DiagnosticsConfig } from "./config.ts"
import type { DiagnosticProvider } from "./provider.ts"
import { DiagnosticsService, type ProviderFactories } from "./service.ts"
import type { Finding } from "./types.ts"

function project(tools: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "diag-svc-"))
  const bin = join(root, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  for (const t of tools) {
    if (t === "sourcekit-lsp") {
      // sourcekit-lsp is resolved from PATH, not node_modules/.bin
      const pathBin = join(root, "path-bin")
      mkdirSync(pathBin, { recursive: true })
      const p = join(pathBin, "sourcekit-lsp")
      writeFileSync(p, "#!/bin/sh\nexit 0\n")
      chmodSync(p, 0o755)
      // Create a project signal for detection
      writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 5.9\n")
    } else {
      const p = join(bin, t)
      writeFileSync(p, "#!/bin/sh\nexit 0\n")
      chmodSync(p, 0o755)
    }
  }
  if (tools.includes("tsgo")) writeFileSync(join(root, "tsconfig.json"), "{}")
  if (tools.includes("tsc")) writeFileSync(join(root, "tsconfig.json"), "{}")
  if (tools.includes("biome")) writeFileSync(join(root, "biome.json"), "{}")
  return root
}

function fakeProvider(
  id: string,
  kind: "type" | "lint" | "format" | "apple",
  out: Finding[],
): DiagnosticProvider {
  return {
    id,
    kind,
    handles: (p) => {
      if (id === "sourcekit-lsp") return /\.(swift|h|m|mm|c|cpp)$/.test(p)
      return p.endsWith(".ts")
    },
    async check() {
      return out
    },
    dispose() {},
    // Fake type providers report out of scope by default, so the
    // isInTypeScope gate correctly lets the out-of-scope fallback fire.
    ...(kind === "type" ? { inScope: () => false } : {}),
  }
}

function factories(map: Record<string, Finding[]>): ProviderFactories {
  return {
    makeTsgo: () => fakeProvider("tsgo", "type", map.tsgo ?? []),
    makeTsc: () => fakeProvider("tsc", "type", map.tsc ?? []),
    makeTscDirect: () => fakeProvider("tsc-direct", "type", map["tsc-direct"] ?? []),
    makeBiome: () => fakeProvider("biome", "format", map.biome ?? []),
    makeOxlint: () => fakeProvider("oxlint", "lint", map.oxlint ?? []),
    makeSourceKit: () => fakeProvider("sourcekit-lsp", "apple", map.sourcekit ?? []),
  }
}

const f = (over: Partial<Finding>): Finding => ({
  source: "tsgo",
  severity: "error",
  message: "m",
  ...over,
})

describe("DiagnosticsService", () => {
  it("wires only detected + config-enabled providers", async () => {
    const root = project(["tsgo", "biome", "oxlint"])
    try {
      // lint disabled by default → oxlint provider not built even though detected
      const svc = new DiagnosticsService(
        root,
        DEFAULT_CONFIG,
        factories({
          tsgo: [f({ source: "tsgo", code: "TS1", line: 1, col: 1 })],
          biome: [f({ source: "biome", severity: "warning", code: "format", message: "fmt" })],
          oxlint: [f({ source: "oxlint", code: "no-x", message: "should not appear" })],
        }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      const sources = res.findings.map((d) => d.source).sort()
      expect(sources).toEqual(["biome", "tsgo"])
      expect(res.notes.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("wires tsc provider when tsc is detected and tsgo is absent", async () => {
    const root = project(["tsc"])
    try {
      const svc = new DiagnosticsService(
        root,
        DEFAULT_CONFIG,
        factories({
          tsc: [
            f({ source: "tsc", code: "TS2532", line: 35, col: 12, message: "possibly undefined" }),
          ],
        }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings.map((d) => d.source)).toEqual(["tsc"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("detection suppresses tsc when tsgo is also present (tsgo wired, tsc not)", async () => {
    // Both binaries exist, tsconfig.json exists → detection finds tsgo first,
    // then skips tsc because of suppressedBy: ["tsgo"].
    const root = project(["tsgo", "tsc"])
    try {
      const svc = new DiagnosticsService(
        root,
        DEFAULT_CONFIG,
        factories({
          tsgo: [f({ source: "tsgo", code: "TS1" })],
          tsc: [f({ source: "tsc", code: "TS9999", message: "should not appear" })],
        }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      const sources = res.findings.map((d) => d.source)
      expect(sources).toEqual(["tsgo"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("includes oxlint when lint:true", async () => {
    const root = project(["oxlint"])
    try {
      const cfg: DiagnosticsConfig = { ...DEFAULT_CONFIG, lint: true }
      const svc = new DiagnosticsService(
        root,
        cfg,
        factories({ oxlint: [f({ source: "oxlint", code: "no-x", message: "x" })] }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings.map((d) => d.source)).toEqual(["oxlint"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns empty for a project with no tools", async () => {
    const root = project([])
    try {
      const svc = new DiagnosticsService(root, DEFAULT_CONFIG, factories({}))
      expect(svc.handles(join(root, "x.ts"))).toBe(false)
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns empty when disabled", async () => {
    const root = project(["tsgo"])
    try {
      const svc = new DiagnosticsService(
        root,
        { ...DEFAULT_CONFIG, enabled: false },
        factories({ tsgo: [f({})] }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("applies the severity floor + cap from config", async () => {
    const root = project(["tsgo"])
    try {
      const cfg: DiagnosticsConfig = { ...DEFAULT_CONFIG, severityFloor: "error", maxInline: 1 }
      const svc = new DiagnosticsService(
        root,
        cfg,
        factories({
          tsgo: [
            f({ severity: "warning", message: "w" }),
            f({ severity: "error", message: "e1", line: 1 }),
            f({ severity: "error", message: "e2", line: 2 }),
          ],
        }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings).toHaveLength(1)
      expect(res.findings[0]?.severity).toBe("error")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("wires sourcekit-lsp by default (apple:true is default)", async () => {
    const root = project(["sourcekit-lsp"])
    try {
      const svc = new DiagnosticsService(
        root,
        DEFAULT_CONFIG,
        factories({ sourcekit: [f({ source: "sourcekit-lsp", code: "E1", message: "err" })] }),
      )
      const res = await svc.check(join(root, "Test.swift"), "let x = 42\n")
      const sources = res.findings.map((d) => d.source)
      expect(sources).toEqual(["sourcekit-lsp"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("respects apple:false to disable sourcekit-lsp", async () => {
    const root = project(["sourcekit-lsp"])
    try {
      const cfg: DiagnosticsConfig = { ...DEFAULT_CONFIG, apple: false }
      const svc = new DiagnosticsService(
        root,
        cfg,
        factories({ sourcekit: [f({ source: "sourcekit-lsp", code: "E1" })] }),
      )
      const res = await svc.check(join(root, "Test.swift"), "let x = 42\n")
      expect(res.findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("sourcekit-lsp handles .swift but not .ts files", async () => {
    const root = project(["sourcekit-lsp"])
    try {
      const svc = new DiagnosticsService(
        root,
        DEFAULT_CONFIG,
        factories({
          sourcekit: [f({ source: "sourcekit-lsp", code: "E1", message: "swift err" })],
        }),
      )
      // .swift file should be handled
      const swiftRes = await svc.check(join(root, "Test.swift"), "let x = 42\n")
      expect(swiftRes.findings.length).toBeGreaterThan(0)

      // .ts file should NOT be handled by sourcekit-lsp
      const tsRes = await svc.check(join(root, "Test.ts"), "let x = 42\n")
      expect(tsRes.findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("runs tsc-direct fallback when normal check returns empty and outOfScope enabled", async () => {
    const root = project(["tsc"])
    try {
      const svc = new DiagnosticsService(
        root,
        DEFAULT_CONFIG,
        factories({
          tsc: [],
          "tsc-direct": [
            f({ source: "tsc-direct", code: "TS2322", message: "type err", scope: "ad-hoc" }),
          ],
        }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings.map((d) => d.source)).toEqual(["tsc-direct"])
      expect(res.findings[0].scope).toBe("ad-hoc")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("skips tsc-direct fallback when outOfScope is disabled", async () => {
    const root = project(["tsc"])
    try {
      const cfg = { ...DEFAULT_CONFIG, outOfScope: { enabled: false } }
      const svc = new DiagnosticsService(
        root,
        cfg,
        factories({
          tsc: [],
          "tsc-direct": [f({ source: "tsc-direct", code: "TS9999", message: "should not appear" })],
        }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("skips tsc-direct fallback when normal check already has findings", async () => {
    const root = project(["tsc"])
    try {
      const svc = new DiagnosticsService(
        root,
        DEFAULT_CONFIG,
        factories({
          tsc: [f({ source: "tsc", code: "TS1", message: "in-scope err" })],
          "tsc-direct": [f({ source: "tsc-direct", code: "TS9999", message: "should not appear" })],
        }),
      )
      const res = await svc.check(join(root, "x.ts"), "code")
      expect(res.findings.map((d) => d.source)).toEqual(["tsc"])
      // No ad-hoc scope — the fallback never ran
      expect(res.findings.every((d) => d.scope !== "ad-hoc")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
