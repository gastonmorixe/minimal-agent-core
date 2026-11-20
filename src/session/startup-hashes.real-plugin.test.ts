import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { resolveSystemPromptForModel } from "../llm/system-prompt.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import { computeStartupHashes } from "./startup-hashes.ts"

// Real plugin repo, found by the shared sibling helper (honors MA_PLUGINS_DIR).
const PLUGIN_SRC = join(SIBLING_REPO_ROOT, "ma-base-prompt-plugin")
// No plugins checkout: skip, do not fail in the beforeAll copy (sibling-repo.ts rule).
const HAVE_BASE_PROMPT = siblingPluginPresent("ma-base-prompt-plugin")
const FIXTURES = join(import.meta.dir, "..", "llm", "__fixtures__", "system-prompt-bytes")
const ROOT = resolve(import.meta.dir, "../../tmp/startup-hashes-real-plugin-tests")
const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const MODEL = "bytes-fixture-unregistered-model"

const DEFAULTS = {
  // Same fixed home as system-prompt-bytes.test.ts, so the fixtures match.
  agentHome: "~/.minimal-agent",
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
  if (!HAVE_BASE_PROMPT) return
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
  // The loader stores its holder in a process-wide slot. Clear it so the no-plugin runs see no base text.
  changedLoader.releaseSystemPromptBase()
  realLoader.releaseSystemPromptBase()
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe.skipIf(!HAVE_BASE_PROMPT)(
  "startup hash and system array with the REAL base prompt plugin",
  () => {
    // Core holds no base text: the plugin is the only source, so its hash differs
    // from the no-plugin hash and is stable across calls.
    test("system hash differs from the hash with no base plugin and is stable", async () => {
      const real0 = await systemHash(withExtras(realLoader))
      const plain = await systemHash(withExtras(null))
      expect(real0).not.toBe(plain)
      const real = await systemHash(withExtras(realLoader))
      expect(real).toBe(real0)
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
  },
)
