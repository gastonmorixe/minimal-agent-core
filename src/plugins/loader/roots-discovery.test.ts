import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { discoverAndParsePackages } from "./discovery.ts"

/**
 * Unit coverage for host-computed plugin roots (S40).
 *
 * `DiscoveryOptions.roots` lists, per tier, absolute dirs that DIRECTLY
 * contain plugin package dirs (each an immediate subdir with a
 * `manifest.json`). Core adds no subdir and knows no default location. A
 * dev checkout of the plugins repo enters as an `embedded` root, so a
 * user/home/project copy with the same id shadows it.
 */

/** Write a minimal but valid plugin package dir with the given manifest id. */
function writePluginDir(parent: string, dirName: string, id: string): void {
  const dir = join(parent, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: `Plugin ${id}`,
      version: "0.0.0",
      description: `Fixture plugin ${id}`,
    }),
  )
  // A PROMPT.md so the package has a contribution and isn't flagged as
  // dead weight (keeps the injected logger quiet for these fixtures).
  writeFileSync(join(dir, "PROMPT.md"), `# ${id}\n\nfixture prompt for ${id}\n`)
}

const NOOP = (_msg: string): void => {}

describe("host-computed plugin roots", () => {
  let root: string
  let sibling: string
  let projectRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sibling-discovery-"))
    // Fake sibling repo: plugin dirs live at its ROOT (no `plugins/` subdir).
    sibling = join(root, "plugins-checkout")
    mkdirSync(sibling, { recursive: true })
    writePluginDir(sibling, "ma-alpha-plugin", "alpha")
    writePluginDir(sibling, "ma-beta-plugin", "beta")
    // A non-plugin dir at the sibling root (no manifest.json) must be skipped.
    mkdirSync(join(sibling, "docs"), { recursive: true })
    writeFileSync(join(sibling, "docs", "README.md"), "not a plugin\n")

    // A project root whose `.agents/plugins` holds a same-id plugin to test
    // precedence: project must shadow the sibling (embedded-tier) copy.
    projectRoot = join(root, "project")
    mkdirSync(join(projectRoot, ".agents", "plugins"), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("discovers embedded-root plugins at root:embedded and skips non-plugin dirs", () => {
    const { parsed } = discoverAndParsePackages({
      roots: { embedded: [sibling] },
      logger: NOOP,
      disabledPluginIds: new Set<string>(),
      enabledPluginIds: new Set<string>(),
    })

    const byId = new Map(parsed.map((p) => [p.manifest.id, p]))
    expect(byId.has("alpha")).toBe(true)
    expect(byId.has("beta")).toBe(true)
    // Both sibling packages enter at the lowest ("embedded") tier.
    expect(byId.get("alpha")?.root).toBe("embedded")
    expect(byId.get("beta")?.root).toBe("embedded")
    // The non-plugin `docs/` dir (no manifest.json) is not discovered.
    expect(parsed.length).toBe(2)
  })

  it("a project-root plugin with the same id shadows the sibling copy", () => {
    // Project provides its OWN `alpha` at highest precedence.
    writePluginDir(join(projectRoot, ".agents", "plugins"), "alpha", "alpha")

    const { parsed } = discoverAndParsePackages({
      roots: { embedded: [sibling], project: [join(projectRoot, ".agents", "plugins")] },
      logger: NOOP,
      disabledPluginIds: new Set<string>(),
      enabledPluginIds: new Set<string>(),
    })

    const alpha = parsed.find((p) => p.manifest.id === "alpha")
    expect(alpha).toBeDefined()
    // Project wins the id collision; the sibling (embedded) copy is dropped.
    expect(alpha?.root).toBe("project")
    // Only one `alpha` survives; `beta` still comes from the sibling.
    expect(parsed.filter((p) => p.manifest.id === "alpha").length).toBe(1)
    const beta = parsed.find((p) => p.manifest.id === "beta")
    expect(beta?.root).toBe("embedded")
  })

  it("scans no dir that the host does not pass", () => {
    writePluginDir(join(projectRoot, ".agents", "plugins"), "alpha", "alpha")
    const { parsed } = discoverAndParsePackages({
      logger: NOOP,
      disabledPluginIds: new Set<string>(),
      enabledPluginIds: new Set<string>(),
    })
    expect(parsed).toEqual([])
  })

  it("orders tiers project > home > user > embedded on an id collision", () => {
    const tiers = ["embedded", "user", "home", "project"] as const
    const dirs = Object.fromEntries(tiers.map((t) => [t, join(root, `tier-${t}`)]))
    for (const t of tiers) writePluginDir(dirs[t] as string, `same-${t}`, "same")
    for (const [index, winner] of tiers.entries()) {
      const present = tiers.slice(0, index + 1)
      const { parsed } = discoverAndParsePackages({
        roots: Object.fromEntries(present.map((t) => [t, [dirs[t] as string]])),
        logger: NOOP,
        disabledPluginIds: new Set<string>(),
        enabledPluginIds: new Set<string>(),
      })
      expect(parsed.find((p) => p.manifest.id === "same")?.root).toBe(winner)
    }
  })
})
