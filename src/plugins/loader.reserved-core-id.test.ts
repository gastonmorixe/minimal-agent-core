import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-reserved-core-id-tests")
const USER = join(ROOT, "user")
const NO_PROJECT = join(ROOT, "nope-project")

function pkg(dirName: string, id: string): void {
  writePackage(USER, dirName, { id, name: id, version: "0.1.0", description: "test" })
}

// The id `core` is the owner of the core annotations in the tool-result
// chain. A package with this id is skipped with a diagnostic. It is not
// fatal (not like `prompts`), so the other packages load and boot continues.
describe("plugin loader / reserved id `core`", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(USER, { recursive: true })
  })
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("skips a package with id `core`, records a diagnostic and loads the other packages", async () => {
    pkg("core", "core")
    pkg("alpha", "alpha")
    pkg("beta", "beta")
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
    const loader = await PluginLoader.load({
      userDir: USER,
      roots: { project: [NO_PROJECT] },
      diagnostics,
    })
    const ids = loader.loadedPluginIds()
    expect(ids).not.toContain("core")
    expect([...ids].sort()).toEqual(["alpha", "beta"])
    const skipped = events.filter(
      (e) => e.message.includes("manifest error") && e.message.includes("reserved"),
    )
    expect(skipped).toHaveLength(1)
    expect(skipped[0]?.message).toContain(join(USER, "plugins", "core"))
  })
})
