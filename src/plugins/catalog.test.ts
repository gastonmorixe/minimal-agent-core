import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { buildPluginCatalog, scanPluginCatalog } from "./catalog.ts"

function writePlugin(root: string, name: string, manifest: Record<string, unknown>): void {
  const dir = join(root, "plugins", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
}

function writeProjectPlugin(
  projectDir: string,
  name: string,
  manifest: Record<string, unknown>,
): void {
  const dir = join(projectDir, ".agents", "plugins", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
}

describe("scanPluginCatalog", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-catalog-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("first-seen id wins across roots (project over embedded)", () => {
    writeProjectPlugin(dir, "proj-copy", { id: "shared", name: "Project Copy" })
    const embeddedRoot = join(dir, "embedded-root")
    writePlugin(embeddedRoot, "emb-copy", { id: "shared", name: "Embedded Copy" })
    writePlugin(embeddedRoot, "emb-only", { id: "embedded-only", name: "Embedded Only" })

    const rows = scanPluginCatalog({
      projectDir: dir,
      embeddedDir: embeddedRoot,
    })
    const shared = rows.find((r) => r.id === "shared")
    expect(shared?.name).toBe("Project Copy")
    expect(shared?.root).toBe("project")
    expect(rows.some((r) => r.id === "embedded-only")).toBe(true)
  })

  test("manifest.enabled=false sets manifestDisabled", () => {
    writePlugin(dir, "optout", { id: "optout", name: "Opt Out", enabled: false })
    const rows = scanPluginCatalog({ embeddedDir: dir })
    expect(rows[0]?.manifestDisabled).toBe(true)
  })
})

describe("buildPluginCatalog", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-catalog-build-"))
    writePlugin(dir, "alpha", { id: "alpha", name: "Alpha" })
    writePlugin(dir, "beta", { id: "beta", name: "Beta", enabled: false })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("config disable marks plugin off with config note", () => {
    const rows = buildPluginCatalog(
      { embeddedDir: dir },
      { config: { forceDisabled: new Set(["alpha"]), forceEnabled: new Set() } },
    )
    const alpha = rows.find((r) => r.id === "alpha")
    expect(alpha?.effectiveOn).toBe(false)
    expect(alpha?.note).toBe("config")
  })

  test("CLI enable overrides manifest opt-out", () => {
    const rows = buildPluginCatalog(
      { embeddedDir: dir },
      {
        config: { forceDisabled: new Set(), forceEnabled: new Set() },
        cliArgs: ["--enable-plugin", "beta"],
      },
    )
    const beta = rows.find((r) => r.id === "beta")
    expect(beta?.effectiveOn).toBe(true)
    expect(beta?.note).toBe("cli")
  })

  test("CLI disable overrides config enable", () => {
    const rows = buildPluginCatalog(
      { embeddedDir: dir },
      {
        config: { forceDisabled: new Set(), forceEnabled: new Set(["alpha"]) },
        cliArgs: ["--disable-plugin", "alpha"],
      },
    )
    const alpha = rows.find((r) => r.id === "alpha")
    expect(alpha?.effectiveOn).toBe(false)
    expect(alpha?.note).toBe("cli")
  })

  test("manifest opt-out without override is off with manifest note", () => {
    const rows = buildPluginCatalog(
      { embeddedDir: dir },
      { config: { forceDisabled: new Set(), forceEnabled: new Set() } },
    )
    const beta = rows.find((r) => r.id === "beta")
    expect(beta?.effectiveOn).toBe(false)
    expect(beta?.note).toBe("manifest")
  })
})
