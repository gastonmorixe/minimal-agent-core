/**
 * bootHost exposes one error renderer registry and fills it from plugin manifests.
 *
 * @module host-public/host-boot-error-renderers.test
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { bootHost } from "../adapters/host-boot.ts"
import { writePackage } from "../plugins/loader.fixtures.ts"

const ROOT = resolve(__dirname, "../../tmp/host-boot-error-renderer-tests")

describe("bootHost errorRenderers", () => {
  let savedHome: string | undefined
  beforeEach(() => {
    savedHome = process.env.MINIMAL_AGENT_HOME
  })
  afterEach(() => {
    if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = savedHome
  })
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, "home"), { recursive: true })
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("exposes a registry and renders through a plugin renderer", async () => {
    const home = join(ROOT, "home")
    writePackage(
      home,
      "hb-er",
      {
        id: "hb-er",
        name: "hb-er",
        version: "0.1.0",
        description: "t",
        errorRenderers: [{ id: "x", entry: "./r.js" }],
      },
      { "r.js": `export default () => ({ kinds: "*", render: (e) => "P:" + e.kind })` },
    )
    const host = await bootHost({
      home,
      pluginRoots: { user: [join(home, "plugins")] },
    })
    expect(host.errorRenderers).toBeDefined()
    expect(host.errorRenderers.render({ kind: "Boom", fields: {} })).toBe("P:Boom")
  })
})
