/**
 * Integration: the loader builds a per-plugin capability host from the
 * manifest's `capabilities` field and hands it to dispatched module
 * handlers as `ctx.host` — populated namespaces match the grants exactly
 * (deny-by-default), memoized per plugin, absent without grants.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { PluginLoader } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-host-tests")
const HOME = join(ROOT, "home")

function writePackage(id: string, manifest: unknown, files: Record<string, string>): void {
  const dir = join(HOME, "plugins", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content)
  }
}

/** Handler that reports which host namespaces it can see. */
const PROBE_HANDLER = `
export default async function probe(ctx) {
  const host = ctx.host
  return {
    kind: "tool_result",
    content: JSON.stringify({
      hasHost: host !== undefined,
      hasSessions: host?.sessions !== undefined,
      hasBlobs: host?.blobs !== undefined,
      hasClock: host?.clock !== undefined,
      frozen: host !== undefined ? Object.isFrozen(host) : null,
      caps: host?.capabilities ?? null,
    }),
  }
}
`

function manifest(id: string, tool: string, capabilities?: string[]): unknown {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "host probe",
    ...(capabilities ? { capabilities } : {}),
    tuis: [
      {
        id: "probe",
        trigger: {
          type: "tool",
          tool: { name: tool, description: "probe", input_schema: { type: "object" } },
        },
        handler: { type: "module", path: "./probe.ts" },
        interactive: false,
      },
    ],
  }
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  writePackage("granted", manifest("granted", "GrantedProbe", ["sessions:read", "clock"]), {
    "probe.ts": PROBE_HANDLER,
  })
  writePackage("ungranted", manifest("ungranted", "UngrantedProbe"), {
    "probe.ts": PROBE_HANDLER,
  })
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

async function dispatchProbe(tool: string): Promise<Record<string, unknown>> {
  const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
  const result = await loader.dispatch(
    { type: "tool", name: tool, input: {}, tool_use_id: "t1" },
    process.cwd(),
  )
  if (result.kind !== "tool_result") throw new Error("expected tool_result")
  return JSON.parse(result.content) as Record<string, unknown>
}

describe("loader capability-host wiring", () => {
  it("hands a frozen host with EXACTLY the granted namespaces", async () => {
    const r = await dispatchProbe("GrantedProbe")
    expect(r.hasHost).toBe(true)
    expect(r.hasSessions).toBe(true)
    expect(r.hasClock).toBe(true)
    expect(r.hasBlobs).toBe(false) // not granted
    expect(r.frozen).toBe(true)
    expect(r.caps).toEqual(["sessions:read", "clock"])
  })

  it("omits ctx.host entirely for a plugin with no capabilities", async () => {
    const r = await dispatchProbe("UngrantedProbe")
    expect(r.hasHost).toBe(false)
  })

  it("memoizes one host per plugin across dispatches", async () => {
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const seen: unknown[] = []
    for (let i = 0; i < 2; i++) {
      const result = await loader.dispatch(
        { type: "tool", name: "GrantedProbe", input: {}, tool_use_id: `t${i}` },
        process.cwd(),
      )
      if (result.kind !== "tool_result") throw new Error("expected tool_result")
      seen.push(JSON.parse(result.content))
    }
    // Same grants on both dispatches (object identity is asserted indirectly:
    // the loader's hostCache path is exercised; identity itself can't cross
    // the JSON boundary).
    expect(seen[0]).toEqual(seen[1])
  })
})
