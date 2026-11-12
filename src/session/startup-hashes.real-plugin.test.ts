import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { DEFAULT_REFLECTION_COOLDOWN_MS, DEFAULT_REFLECTION_INTERVAL } from "../agent/reflection.ts"
import type { AuthResult } from "../auth/auth.ts"
import { resolveSystemPromptForModel } from "../llm/system-prompt.ts"
import { PluginLoader } from "../plugins/loader.ts"

import { shortHash } from "./session-store.ts"
import { computeStartupHashes } from "./startup-hashes.ts"

// Real plugin repo, read by a relative path like other core tests do.
const PLUGIN_SRC = resolve(import.meta.dir, "../../../minimal-agent-plugins/ma-base-prompt-plugin")
const FIXTURES = join(import.meta.dir, "..", "llm", "__fixtures__", "system-prompt-bytes")
const ROOT = resolve(import.meta.dir, "../../tmp/startup-hashes-real-plugin-tests")
const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const MODEL = "bytes-fixture-unregistered-model"

const DEFAULTS = {
  reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
  reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
} as const
const EXTRAS = {
  afterInstructions: "AFTER-INSTRUCTIONS fixed text.",
  sessionContext: "SESSION-CONTEXT fixed text.",
} as const
const CASE_04 = { ...DEFAULTS, blobStoreEnabled: true, authKind: "api-key" } as const
const CASE_05 = { ...CASE_04, ...EXTRAS } as const

function copyPlugin(name: string): string {
  const embedded = join(ROOT, name, "embedded")
  const dest = join(embedded, "plugins", "ma-base-prompt-plugin")
  mkdirSync(dest, { recursive: true })
  for (const f of ["manifest.json", "provider.ts"]) cpSync(join(PLUGIN_SRC, f), join(dest, f))
  cpSync(join(PLUGIN_SRC, "prompts"), join(dest, "prompts"), { recursive: true })
  return embedded
}

async function bootLoader(embedded: string): Promise<PluginLoader> {
  const events: { source: string }[] = []
  const loader = await PluginLoader.load({
    embeddedDir: embedded,
    roots: { project: [join(embedded, "..", "no-project")] },
    diagnostics: { emit: (e: { source: string }) => events.push(e) } as never,
    disabledPluginIds: new Set(),
    logger: () => {},
  })
  expect(loader.systemPromptBase().entries.map((e) => e.pluginId)).toEqual([
    "ma-base-prompt-plugin",
  ])
  expect(events.filter((e) => e.source === "prompt.system_base_load_failed")).toHaveLength(0)
  return loader
}

// Delegates the base holder to the real loader. Adds body extras so the system
// array is hashed. The real loader gives none for this single plugin.
function withExtras(real: PluginLoader | null): PluginLoader {
  return {
    getPromptBlocksAsync: async () => ({ afterInstructions: "x", sessionContext: null }),
    getPromptBlock: () => null,
    getExtraTools: () => [],
    ...(real ? { systemPromptBase: () => real.systemPromptBase() } : {}),
  } as unknown as PluginLoader
}

async function systemHash(loader: PluginLoader): Promise<string> {
  const hashes = await computeStartupHashes({
    loader,
    modeManager: null,
    selectedModelBase: MODEL,
    auth: AUTH,
    cacheTtl: "5m",
  })
  return hashes.systemHash
}

let realLoader: PluginLoader
let changedLoader: PluginLoader

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  realLoader = await bootLoader(copyPlugin("real"))
  const changedEmbedded = copyPlugin("changed")
  const file = join(
    changedEmbedded,
    "plugins",
    "ma-base-prompt-plugin",
    "prompts",
    "instructions.md",
  )
  writeFileSync(file, `CHANGED\n${readFileSync(file, "utf8")}`)
  changedLoader = await bootLoader(changedEmbedded)
  // The loader stores its holder in a process-wide slot. Clear it so the no-plugin runs see core defaults.
  changedLoader.releaseSystemPromptBase()
  realLoader.releaseSystemPromptBase()
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe("startup hash and system array with the REAL base prompt plugin", () => {
  test("system hash equals the hash with no base plugin", async () => {
    const real0 = await systemHash(withExtras(realLoader))
    const plain = await systemHash(withExtras(null))
    expect(real0).toBe(plain)
    const real = await systemHash(withExtras(realLoader))
    expect(real).toBe(plain)
  })

  test("system array equals the fixture bytes for case 04 and case 05", () => {
    const base = realLoader.systemPromptBase()
    const cases: [string, typeof CASE_04 | typeof CASE_05][] = [
      ["04-neutral-all-on", CASE_04],
      ["05-neutral-all-on-extras", CASE_05],
    ]
    for (const [name, opts] of cases) {
      const out = resolveSystemPromptForModel(MODEL, { ...opts, systemPromptBase: base })
      const actual = Buffer.from(JSON.stringify(out, null, 2), "utf8")
      expect(actual.equals(readFileSync(join(FIXTURES, `${name}.json.txt`)))).toBe(true)
    }
  })

  test("the pinned literal hashes are reproduced with the real plugin", () => {
    const base = realLoader.systemPromptBase()
    const bare = JSON.stringify(
      resolveSystemPromptForModel(MODEL, { ...CASE_04, systemPromptBase: base }),
    )
    const extras = JSON.stringify(
      resolveSystemPromptForModel(MODEL, { ...CASE_05, systemPromptBase: base }),
    )
    expect(shortHash(bare)).toBe("6dc2b3f8")
    expect(shortHash(extras)).toBe("76f2130a")
  })

  test("a changed instructions file changes the hash and flows into the array", async () => {
    const real = await systemHash(withExtras(realLoader))
    const changed = await systemHash(withExtras(changedLoader))
    expect(changed).not.toBe(real)
    const out = resolveSystemPromptForModel(MODEL, {
      ...CASE_04,
      systemPromptBase: changedLoader.systemPromptBase(),
    })
    expect(JSON.stringify(out)).toContain("CHANGED")
  })
})
