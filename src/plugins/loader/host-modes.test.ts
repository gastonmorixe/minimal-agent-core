/**
 * Loader resolution of `hostModes[]` entries (`host-modes.ts`), through the
 * real {@link PluginLoader.load}: the implicit `hostMode:stdio` permission,
 * first-wins by id, and a lenient skip for an entry that cannot load.
 *
 * @module plugins/loader/host-modes.test
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import { CORE_TOOLS, writePackage } from "../loader.fixtures.ts"
import { PluginLoader } from "../loader.ts"

// Own root, so this file never races `loader.test.ts` over its shared root.
const ROOT = resolve(import.meta.dir, "../../../tmp/host-modes-loader-tests")
const HOME = join(ROOT, "home")

const ENTRY_BODY = "export default async function entry(ctx) { return 42 }"

function hostModePackage(
  id: string,
  opts: { modeId?: string; permissions?: string[]; files?: Record<string, string> } = {},
): void {
  writePackage(
    HOME,
    id,
    {
      id,
      name: id,
      version: "0.1.0",
      description: `${id} host mode`,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      hostModes: [
        {
          id: opts.modeId ?? "acp",
          description: "test host mode",
          entry: { type: "module", path: "./entry.ts" },
        },
      ],
    },
    opts.files ?? { "entry.ts": ENTRY_BODY },
  )
}

/** Loads the fake user root and collects every loader log message. */
async function load(): Promise<{ loader: PluginLoader; messages: string[] }> {
  const messages: string[] = []
  const loader = await PluginLoader.load({
    userDir: HOME,
    roots: { project: [join(ROOT, "nope-project", ".agents", "plugins")] },
    coreToolNames: CORE_TOOLS,
    logger: (m) => messages.push(m),
  })
  return { loader, messages }
}

describe("PluginLoader hostModes resolution", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
  })
  afterEach(() => {
    rmSync(join(HOME, "plugins"), { recursive: true, force: true })
  })
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("resolves an entry with the hostMode:stdio permission to a callable handler", async () => {
    hostModePackage("acp-plugin", { permissions: ["hostMode:stdio"] })
    const { loader } = await load()

    const mode = loader.findHostMode("acp")
    expect(mode?.pluginId).toBe("acp-plugin")
    expect(mode?.entryAbsolute.endsWith("entry.ts")).toBe(true)
    expect(await mode?.handler({} as never)).toBe(42)
    expect(loader.getHostModes().map((m) => m.spec.id)).toEqual(["acp"])
    expect(loader.findHostMode("other")).toBeUndefined()
  })

  it("counts a host mode as a contribution (no dead-weight warning)", async () => {
    hostModePackage("only-host-mode", { permissions: ["hostMode:stdio"] })
    const { messages } = await load()

    expect(messages.some((m) => m.includes("declares no contributions"))).toBe(false)
  })

  it("skips every entry of a plugin without the hostMode:stdio permission", async () => {
    hostModePackage("no-perm")
    const { loader, messages } = await load()

    expect(loader.findHostMode("acp")).toBeUndefined()
    expect(messages.some((m) => m.includes('needs the "hostMode:stdio" permission'))).toBe(true)
  })

  it("skips an entry whose module is missing, without failing the load", async () => {
    hostModePackage("missing-entry", { permissions: ["hostMode:stdio"], files: {} })
    const { loader, messages } = await load()

    expect(loader.findHostMode("acp")).toBeUndefined()
    expect(messages.some((m) => m.includes("entry module not found"))).toBe(true)
  })

  it("skips an entry with no default export function", async () => {
    hostModePackage("no-default", {
      permissions: ["hostMode:stdio"],
      files: { "entry.ts": "export const x = 1" },
    })
    const { loader, messages } = await load()

    expect(loader.findHostMode("acp")).toBeUndefined()
    expect(messages.some((m) => m.includes("no default export function"))).toBe(true)
  })

  it("keeps the first plugin when two plugins contribute the same id", async () => {
    hostModePackage("a-first", { permissions: ["hostMode:stdio"] })
    hostModePackage("b-second", { permissions: ["hostMode:stdio"] })
    const { loader, messages } = await load()

    expect(loader.getHostModes()).toHaveLength(1)
    expect(messages.some((m) => m.includes('host mode "acp" collides'))).toBe(true)
  })
})
