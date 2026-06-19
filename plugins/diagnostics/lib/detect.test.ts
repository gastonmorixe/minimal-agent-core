/**
 * Tests for project tool DETECTION. We never install anything: we probe the
 * project's own `node_modules/.bin` + config files + package.json devDeps and
 * use whatever is already there. Detection is a pure function over a root dir
 * so it tests against temp fixtures with no spawning.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { type DetectedTool, detectTools, findAppleProjectRoot } from "./detect.ts"

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
  it("only detects PATH-based tools for an empty project (sourcekit-lsp on PATH)", () => {
    const root = scratch()
    try {
      const tools = detectTools(root)
      // PATH-based tools like sourcekit-lsp may be detected even without
      // project config; node_modules/.bin tools require the binary + config.
      const sourcekit = byId(tools, "sourcekit-lsp")
      if (sourcekit) {
        // sourcekit-lsp is on PATH — it's expected to show up
        expect(sourcekit.kind).toBe("apple")
        expect(sourcekit.persistent).toBe(true)
      } else {
        // sourcekit-lsp is not on PATH — empty project should have 0 tools
        expect(tools).toEqual([])
      }
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

  it("detects tsc (type) when binary + tsconfig exist, no tsgo present", () => {
    const root = scratch()
    try {
      makeBin(root, "tsc")
      writeFileSync(join(root, "tsconfig.json"), "{}")
      const tools = detectTools(root)
      const tsc = byId(tools, "tsc")
      expect(tsc).toBeDefined()
      expect(tsc?.kind).toBe("type")
      expect(tsc?.persistent).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("suppresses tsc when tsgo is also detected (tsgo wins)", () => {
    const root = scratch()
    try {
      makeBin(root, "tsgo")
      makeBin(root, "tsc")
      writeFileSync(join(root, "tsconfig.json"), "{}")
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          devDependencies: { "@typescript/native-preview": "*", typescript: "^5" },
        }),
      )
      const tools = detectTools(root)
      expect(byId(tools, "tsgo")).toBeDefined()
      expect(byId(tools, "tsc")).toBeUndefined() // suppressed by tsgo
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
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 5.9\n")
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
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 5.9\n")
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

  it("detects sourcekit-lsp from PATH even without a project signal (fallback)", () => {
    const root = scratch()
    const pathDir = join(root, "my-bin")
    mkdirSync(pathDir, { recursive: true })
    const binPath = join(pathDir, "sourcekit-lsp")
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n")
    chmodSync(binPath, 0o755)
    // No Package.swift, no .xcodeproj, no .xcworkspace — sourcekit-lsp is on
    // PATH and can work without project context (basic syntax checking).
    try {
      const tools = detectTools(root, { path: pathDir })
      expect(byId(tools, "sourcekit-lsp")).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does NOT detect sourcekit-lsp without the binary on PATH even with Package.swift", () => {
    const root = scratch()
    // sourcekit-lsp binary does NOT exist on PATH
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 5.9\n")
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

describe("findAppleProjectRoot", () => {
  it("finds root when Package.swift is in the file's directory", () => {
    const root = scratch()
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 5.9\n")
    const probe = join(root, "Sources", "App", "ContentView.swift")
    mkdirSync(join(root, "Sources", "App"), { recursive: true })
    writeFileSync(probe, "import SwiftUI\n")
    try {
      expect(findAppleProjectRoot(probe)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("finds root when Package.swift is two directories up", () => {
    const root = scratch()
    writeFileSync(join(root, "Package.swift"), "// swift-tools-version: 5.9\n")
    const probe = join(root, "Sources", "App", "Utils", "Helpers.swift")
    mkdirSync(join(root, "Sources", "App", "Utils"), { recursive: true })
    writeFileSync(probe, "func help() {}\n")
    try {
      expect(findAppleProjectRoot(probe)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("finds root when .xcodeproj is in an ancestor directory", () => {
    const root = scratch()
    mkdirSync(join(root, "MyApp.xcodeproj"), { recursive: true })
    const probe = join(root, "MyApp", "View.swift")
    mkdirSync(join(root, "MyApp"), { recursive: true })
    writeFileSync(probe, "import SwiftUI\n")
    try {
      expect(findAppleProjectRoot(probe)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("finds root when .xcworkspace is in an ancestor directory", () => {
    const root = scratch()
    mkdirSync(join(root, "MyApp.xcworkspace"), { recursive: true })
    const probe = join(root, "MyApp", "Subdir", "View.swift")
    mkdirSync(join(root, "MyApp", "Subdir"), { recursive: true })
    writeFileSync(probe, "import SwiftUI\n")
    try {
      expect(findAppleProjectRoot(probe)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns null when no Xcode project signal is found", () => {
    const root = scratch()
    const probe = join(root, "src", "file.swift")
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(probe, "import SwiftUI\n")
    try {
      expect(findAppleProjectRoot(probe)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("returns null for a non-Apple file path in a non-project directory", () => {
    const root = scratch()
    const probe = join(root, "src", "index.ts")
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(probe, "const x = 1\n")
    try {
      expect(findAppleProjectRoot(probe)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
