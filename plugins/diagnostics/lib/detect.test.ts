/**
 * Tests for project tool DETECTION. We never install anything: we probe the
 * project's own `node_modules/.bin` + config files + package.json devDeps and
 * use whatever is already there. Detection is a pure function over a root dir
 * so it tests against temp fixtures with no spawning.
 */
import { describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { detectTools, type DetectedTool } from "./detect.ts"

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
})
