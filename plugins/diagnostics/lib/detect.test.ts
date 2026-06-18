/**
 * Tests for project tool DETECTION. We never install anything: we probe the
 * project's own `node_modules/.bin` + config files + package.json devDeps and
 * use whatever is already there. Detection is a pure function over a root dir
 * so it tests against temp fixtures with no spawning.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { type DetectedTool, detectTools } from "./detect.ts"

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "diag-detect-"))
}

function makeBin(root: string, name: string): void {
  const binDir = join(root, "node_modules", ".bin")
  mkdirSync(binDir, { recursive: true })
  const p = join(binDir, name)
  writeFileSync(p, "#!/bin/sh\nexit 0\n")
  chmodSync(p, 0o755)
}

const byId = (tools: DetectedTool[], id: string) => tools.find((t) => t.id === id)

describe("detectTools", () => {
  it("returns nothing for an empty project", () => {
    const root = scratch()
    try {
      expect(detectTools(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("detects biome when the binary + config exist", () => {
    const root = scratch()
    try {
      makeBin(root, "biome")
      writeFileSync(join(root, "biome.json"), "{}")
      const tools = detectTools(root)
      const biome = byId(tools, "biome")
      expect(biome).toBeDefined()
      expect(biome?.kind).toBe("format")
      expect(biome?.bin.endsWith("node_modules/.bin/biome")).toBe(true)
      expect(biome?.configFound).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("detects oxlint via binary even without a config (config optional)", () => {
    const root = scratch()
    try {
      makeBin(root, "oxlint")
      const tools = detectTools(root)
      const ox = byId(tools, "oxlint")
      expect(ox).toBeDefined()
      expect(ox?.kind).toBe("lint")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("detects tsgo (type) when the binary exists and a tsconfig is present", () => {
    const root = scratch()
    try {
      makeBin(root, "tsgo")
      writeFileSync(join(root, "tsconfig.json"), "{}")
      const tools = detectTools(root)
      const tsgo = byId(tools, "tsgo")
      expect(tsgo).toBeDefined()
      expect(tsgo?.kind).toBe("type")
      expect(tsgo?.persistent).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does NOT detect tsgo without a tsconfig (no project to check)", () => {
    const root = scratch()
    try {
      makeBin(root, "tsgo")
      const tools = detectTools(root)
      expect(byId(tools, "tsgo")).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("prefers an explicit config signal in package.json devDependencies", () => {
    const root = scratch()
    try {
      makeBin(root, "biome")
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ devDependencies: { "@biomejs/biome": "^2.0.0" } }),
      )
      const biome = byId(detectTools(root), "biome")
      expect(biome).toBeDefined()
      expect(biome?.configFound).toBe(true) // devDep counts as a signal
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("is resilient to a malformed package.json", () => {
    const root = scratch()
    try {
      makeBin(root, "oxlint")
      writeFileSync(join(root, "package.json"), "{ this is not json")
      expect(() => detectTools(root)).not.toThrow()
      expect(byId(detectTools(root), "oxlint")).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("resolves a PATH-based binary via options.path", () => {
    const root = scratch()
    const pathDir = join(root, "my-bin")
    mkdirSync(pathDir, { recursive: true })
    const binPath = join(pathDir, "sourcekit-lsp")
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n")
    chmodSync(binPath, 0o755)
    writeFileSync(join(root, "Package.swift"), '// swift-tools-version: 5.9\n')
    try {
      const tools = detectTools(root, { path: pathDir })
      const sk = byId(tools, "sourcekit-lsp")
      expect(sk).toBeDefined()
      expect(sk?.kind).toBe("apple")
      expect(sk?.bin).toBe(binPath)
      expect(sk?.persistent).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("detects sourcekit-lsp from PATH with Package.swift signal", () => {
    const root = scratch()
    const pathDir = join(root, "my-bin")
    mkdirSync(pathDir, { recursive: true })
    const binPath = join(pathDir, "sourcekit-lsp")
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n")
    chmodSync(binPath, 0o755)
    writeFileSync(join(root, "Package.swift"), '// swift-tools-version: 5.9\n')
    try {
      const tools = detectTools(root, { path: pathDir })
      expect(byId(tools, "sourcekit-lsp")).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("detects sourcekit-lsp from PATH with .xcodeproj directory signal", () => {
    const root = scratch()
    const pathDir = join(root, "my-bin")
    mkdirSync(pathDir, { recursive: true })
    const binPath = join(pathDir, "sourcekit-lsp")
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n")
    chmodSync(binPath, 0o755)
    mkdirSync(join(root, "MyApp.xcodeproj"), { recursive: true })
    try {
      const tools = detectTools(root, { path: pathDir })
      expect(byId(tools, "sourcekit-lsp")).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("detects sourcekit-lsp from PATH with .xcworkspace directory signal", () => {
    const root = scratch()
    const pathDir = join(root, "my-bin")
    mkdirSync(pathDir, { recursive: true })
    const binPath = join(pathDir, "sourcekit-lsp")
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n")
    chmodSync(binPath, 0o755)
    mkdirSync(join(root, "MyApp.xcworkspace"), { recursive: true })
    try {
      const tools = detectTools(root, { path: pathDir })
      expect(byId(tools, "sourcekit-lsp")).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does NOT detect sourcekit-lsp from PATH without a project signal", () => {
    const root = scratch()
    const pathDir = join(root, "my-bin")
    mkdirSync(pathDir, { recursive: true })
    const binPath = join(pathDir, "sourcekit-lsp")
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n")
    chmodSync(binPath, 0o755)
    // No Package.swift, no .xcodeproj, no .xcworkspace
    try {
      const tools = detectTools(root, { path: pathDir })
      expect(byId(tools, "sourcekit-lsp")).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does NOT detect sourcekit-lsp without the binary on PATH even with Package.swift", () => {
    const root = scratch()
    // sourcekit-lsp binary does NOT exist on PATH
    writeFileSync(join(root, "Package.swift"), '// swift-tools-version: 5.9\n')
    try {
      const tools = detectTools(root, { path: join(root, "empty-bin") })
      expect(byId(tools, "sourcekit-lsp")).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("still finds node_modules/.bin tools when options.path is set", () => {
    const root = scratch()
    makeBin(root, "biome")
    writeFileSync(join(root, "biome.json"), "{}")
    try {
      const tools = detectTools(root, { path: "/nonexistent" })
      const biome = byId(tools, "biome")
      expect(biome).toBeDefined()
      expect(biome?.kind).toBe("format")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
