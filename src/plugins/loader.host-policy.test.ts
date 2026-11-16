import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type {
  HostPolicySnapshot,
  StartupProfile,
} from "@minimal-agent/core/plugin-api/types/startup-profile"

import { CORE_TOOLS, ROOT, toolManifest, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const PROBE_BODY = `
export default async function handler(ctx) {
  return {
    kind: "tool_result",
    content: JSON.stringify({
      hasPolicy: typeof ctx.queryHostPolicy === "function",
      hasProfile: typeof ctx.startupProfile === "function",
      policy: ctx.queryHostPolicy ? ctx.queryHostPolicy() ?? null : null,
      profile: ctx.startupProfile ? ctx.startupProfile() ?? null : null,
    }),
  };
}
`

const SNAP: HostPolicySnapshot = {
  activeModeId: "ask",
  modes: [{ id: "ask", label: "ASK", permissions: { allow: ["*"], deny: ["Edit"], match: [] } }],
  tools: { kind: "list", names: ["Read"] },
}

const PROFILE: StartupProfile = {
  version: 1,
  systemPrompt: {},
  noAgentsMd: false,
  pluginPrompts: { all: false, suppress: [], keep: [] },
  plugins: { disable: [], enable: [] },
  bare: false,
  tools: { kind: "all" },
}

describe("PluginLoader / host policy + startup profile ctx members", () => {
  const HOME_HP = join(ROOT, "home-hp")
  beforeAll(() => mkdirSync(HOME_HP, { recursive: true }))
  afterAll(() => rmSync(HOME_HP, { recursive: true, force: true }))

  async function probe(loader: PluginLoader, id: string): Promise<Record<string, unknown>> {
    const result = await loader.dispatch(
      { type: "tool", name: id, input: {}, tool_use_id: `toolu_${id}` },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    return JSON.parse(result.content) as Record<string, unknown>
  }

  it("omits both members when the host did not wire them", async () => {
    writePackage(HOME_HP, "hp1", toolManifest("hp1", "hp_probe_1", "./h.ts"), {
      "h.ts": PROBE_BODY,
    })
    const loader = await PluginLoader.load({
      userDir: HOME_HP,
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
      coreToolNames: CORE_TOOLS,
    })
    const out = await probe(loader, "hp_probe_1")
    expect(out.hasPolicy).toBe(false)
    expect(out.hasProfile).toBe(false)
    rmSync(join(HOME_HP, "plugins", "hp1"), { recursive: true })
  })

  it("exposes queryHostPolicy and startupProfile after the setters run", async () => {
    writePackage(HOME_HP, "hp2", toolManifest("hp2", "hp_probe_2", "./h.ts"), {
      "h.ts": PROBE_BODY,
    })
    const loader = await PluginLoader.load({
      userDir: HOME_HP,
      roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
      coreToolNames: CORE_TOOLS,
    })
    loader.setHostPolicySource(() => SNAP)
    loader.setStartupProfile({ path: "/x/sid.profile.json", profile: PROFILE })
    const out = await probe(loader, "hp_probe_2")
    expect(out.hasPolicy).toBe(true)
    expect(out.hasProfile).toBe(true)
    expect(out.policy).toEqual(SNAP)
    expect(out.profile).toEqual({ path: "/x/sid.profile.json", profile: PROFILE })

    loader.setStartupProfile(undefined)
    const cleared = await probe(loader, "hp_probe_2")
    expect(cleared.hasProfile).toBe(false)
    rmSync(join(HOME_HP, "plugins", "hp2"), { recursive: true })
  })
})
