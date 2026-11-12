/**
 * Required-contract boot check, SDK side (S0.4b, warn mode).
 *
 * @module sdk/agent-core.required-contracts.test
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { bootHost, type HostBootOptions } from "../adapters/host-boot.ts"
import { TOOL_HANDLER_BODY, toolManifest, writePackage } from "../plugins/loader.fixtures.ts"

const root = mkdtempSync(join(tmpdir(), "req-contracts-"))
const savedHome = process.env.MINIMAL_AGENT_HOME
let n = 0

afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

/** Boot a host with an empty or one-provider plugin set. */
async function boot(opts: { provider?: boolean; extra?: Partial<HostBootOptions> }) {
  const home = join(root, `h${++n}`)
  mkdirSync(join(home, "plugins"), { recursive: true })
  if (opts.provider) {
    const manifest = { ...toolManifest("rc-prov", "rc_tool", "./tool.ts"), provides: ["c.one"] }
    writePackage(home, "rc-prov", manifest, { "tool.ts": TOOL_HANDLER_BODY })
  }
  const host = await bootHost({
    home,
    pluginRoots: { user: [join(home, "plugins")] },
    ...opts.extra,
  })
  return host.diagnostics.filter(
    (d) =>
      d.kind === "plugin-warning" && d.message === "" && d.code !== "prompt.no_template_provider",
  )
}

describe("bootHost requiredContracts + allowBareCore (warn mode)", () => {
  it("records a missing contract for a bare boot", async () => {
    const d = await boot({ extra: { requiredContracts: ["c.one"] } })
    expect(d.length).toBe(1)
    expect(d[0]?.code).toBe("boot.contract_missing")
    expect(d[0]?.data).toEqual({ contract: "c.one" })
  })
  it("skips the check with allowBareCore and zero plugins", async () => {
    const d = await boot({ extra: { requiredContracts: ["c.one"], allowBareCore: true } })
    expect(d).toEqual([])
  })
  it("records nothing when one plugin provides the contract", async () => {
    const d = await boot({ provider: true, extra: { requiredContracts: ["c.one"] } })
    expect(d).toEqual([])
  })
  it("records nothing when requiredContracts is unset", async () => {
    expect(await boot({})).toEqual([])
  })
})
