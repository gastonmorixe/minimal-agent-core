/**
 * Tests for plugin discovery → dynamic config fields.
 *
 * @module config/lib/discovery.test
 */

import { describe, expect, it } from "bun:test"

import { type DiscoverDeps, discoverPlugins, pluginFields } from "./discovery.ts"

/** Build an in-memory fs fake from a `{ "root/sub/file": contents }` map. */
function fakeFs(roots: string[], tree: Record<string, string>): DiscoverDeps {
  const join = (...p: string[]): string => p.join("/")
  return {
    roots,
    join,
    readDir: (path: string) => {
      const prefix = path.endsWith("/") ? path : path + "/"
      const names = new Set<string>()
      for (const key of Object.keys(tree)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length)
          const seg = rest.split("/")[0]
          if (seg) names.add(seg)
        }
      }
      return [...names]
    },
    readFile: (path: string) => tree[path] ?? null,
  }
}

describe("discoverPlugins", () => {
  it("finds plugins with a valid manifest id across roots", () => {
    const deps = fakeFs(["/proj/.agents/plugins", "/home/.agents/plugins"], {
      "/proj/.agents/plugins/alpha/manifest.json": JSON.stringify({
        id: "alpha",
        name: "Alpha",
        description: "Does A.",
      }),
      "/home/.agents/plugins/beta/manifest.json": JSON.stringify({
        id: "beta",
        name: "Beta",
        description: "Does B. More.",
      }),
    })
    const found = discoverPlugins(deps)
    expect(found.map((p) => p.id)).toEqual(["alpha", "beta"])
    expect(found[0]).toMatchObject({ id: "alpha", name: "Alpha" })
  })

  it("first-seen id wins across roots (precedence by root order)", () => {
    const deps = fakeFs(["/proj/.agents/plugins", "/home/.agents/plugins"], {
      "/proj/.agents/plugins/dup/manifest.json": JSON.stringify({ id: "dup", name: "Project" }),
      "/home/.agents/plugins/dup/manifest.json": JSON.stringify({ id: "dup", name: "Home" }),
    })
    const found = discoverPlugins(deps)
    expect(found).toHaveLength(1)
    expect(found[0]!.name).toBe("Project")
  })

  it("skips dirs without a manifest, with bad JSON, or without an id", () => {
    const deps = fakeFs(["/r"], {
      "/r/nomani/readme.md": "x",
      "/r/badjson/manifest.json": "{ not json",
      "/r/noid/manifest.json": JSON.stringify({ name: "x" }),
      "/r/ok/manifest.json": JSON.stringify({ id: "ok" }),
    })
    expect(discoverPlugins(deps).map((p) => p.id)).toEqual(["ok"])
  })

  it("flags manifest enabled:false as off-by-default", () => {
    const deps = fakeFs(["/r"], {
      "/r/exp/manifest.json": JSON.stringify({ id: "exp", enabled: false }),
    })
    expect(discoverPlugins(deps)[0]!.manifestDisabled).toBe(true)
  })
})

describe("pluginFields", () => {
  it("emits a boolean field bound to plugins.<id>.enabled", () => {
    const fields = pluginFields([
      {
        id: "alpha",
        name: "Alpha",
        description: "Does A. Detail.",
        dir: "/d",
        root: "/r",
        manifestDisabled: false,
      },
    ])
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({
      id: "plugin:alpha",
      label: "alpha",
      kind: "boolean",
      path: ["plugins", "alpha", "enabled"],
      section: "Plugins (enable / disable)",
    })
    expect(fields[0]!.help).toContain("Does A.")
  })

  it("marks off-by-default plugins in the hint", () => {
    const [f] = pluginFields([
      { id: "exp", name: "Exp", description: "", dir: "/d", root: "/r", manifestDisabled: true },
    ])
    expect(f!.defaultHint).toBe("off by default")
  })
})
