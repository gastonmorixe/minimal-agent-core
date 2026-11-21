/**
 * P3.5 boot contract check: TEXT_CONTRACTS, ContractCheckFailedError, and
 * the F2 tier rule (closer tier wins, same tier is a duplicate).
 *
 * Stub text plugins stand in for the 4 first-party text plugins, so the
 * tests never touch the real plugin packages.
 *
 * @module plugins/loader.contract-check.test
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import { SYNTHETIC_KINDS } from "../../plugin-api/src/types/synthetic-text.ts"
import { bootHost } from "../adapters/host-boot.ts"
import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { ContractCheckFailedError } from "../errors/contract-check.ts"
import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import { withDerivedProvides } from "./loader/discovery.ts"
import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import {
  findSystemPromptBaseDataIssue,
  parseSystemPromptBaseData,
  resolveBaseIdentity,
} from "./system-prompt-base.ts"
import {
  REQUIRED_SYNTHETIC_KINDS,
  syntheticContract,
  TEXT_CONTRACTS,
  UNREQUIRED_SYNTHETIC_KINDS,
} from "./text-contracts.ts"
import type { ManifestFile } from "./types.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-contract-check-tests")
const EMBEDDED = join(ROOT, "embedded")
const USER = join(ROOT, "user")
const PROJECT = join(ROOT, "project")

/** Kinds of the stub core-tools plugin (tool_output, tool_text, mode). */
const TOOLS_KINDS = REQUIRED_SYNTHETIC_KINDS.filter(
  (k) => k.startsWith("tool_output.") || k.startsWith("tool_text.") || k.startsWith("mode."),
)
/** Kinds of the stub turn-recovery plugin (every other required kind). */
const RECOVERY_KINDS = REQUIRED_SYNTHETIC_KINDS.filter((k) => !TOOLS_KINDS.includes(k))

const synthProv = (kinds: readonly string[], text: string) =>
  `export default () => ({ kinds: ${JSON.stringify(kinds)}, text: () => ${JSON.stringify(text)} })`

function pkg(
  root: string,
  id: string,
  extra: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  writePackage(root, id, { id, name: id, version: "0.1.0", description: "t", ...extra }, files)
}

/** Write the 4 stub text plugins in `root`, minus the ids in `skip`. */
function textPlugins(root: string, skip: readonly string[] = []) {
  const all: Record<string, () => void> = {
    "stub-base": () =>
      pkg(
        root,
        "stub-base",
        {
          required: true,
          systemPromptBase: {
            id: "base",
            entry: "./base.js",
            identity: true,
            slots: ["instructions"],
          },
        },
        {
          "base.js": `export default () => ({ slots: ["instructions"], identity: () => "BASE-ID", instructionParts: () => [] })`,
        },
      ),
    "stub-template": () =>
      pkg(root, "stub-template", { required: true, provides: ["prompts.template"] }),
    "stub-recovery": () =>
      pkg(
        root,
        "stub-recovery",
        { required: true, syntheticText: [{ id: "s", entry: "./p.js", kinds: RECOVERY_KINDS }] },
        { "p.js": synthProv(RECOVERY_KINDS, "R") },
      ),
    "stub-tools": () =>
      pkg(
        root,
        "stub-tools",
        {
          required: true,
          toolText: [{ id: "t", entry: "./t.js", tools: ["Read"] }],
          syntheticText: [{ id: "s", entry: "./p.js", kinds: TOOLS_KINDS }],
        },
        {
          "t.js": `export default () => ({ tools: ["Read"], tool: () => ({ description: "D" }) })`,
          "p.js": synthProv(TOOLS_KINDS, "T"),
        },
      ),
  }
  for (const [id, write] of Object.entries(all)) if (!skip.includes(id)) write()
}

async function load(opts: { mode?: "warn" | "fail"; allowBareCore?: boolean } = {}) {
  const events: LogEvent[] = []
  const loader = await PluginLoader.load({
    roots: {
      embedded: [join(EMBEDDED, "plugins")],
      user: [join(USER, "plugins")],
      project: [join(PROJECT, "plugins")],
    },
    diagnostics: createDiagnostics({ emit: (e: LogEvent) => events.push(e) }),
    logger: () => {},
    requiredContracts: TEXT_CONTRACTS,
    contractCheckMode: opts.mode ?? "fail",
    ...(opts.allowBareCore !== undefined ? { allowBareCore: opts.allowBareCore } : {}),
  })
  return { loader, events }
}

const bySource = (events: LogEvent[], source: string) => events.filter((e) => e.source === source)

describe("TEXT_CONTRACTS", () => {
  it("lists the system contracts, text.tools, prompts.template and the required kinds", () => {
    expect(TEXT_CONTRACTS.slice(0, 4)).toEqual([
      "text.system.identity",
      "text.system.instructions",
      "text.tools",
      "prompts.template",
    ])
    expect(REQUIRED_SYNTHETIC_KINDS).toHaveLength(73)
    expect(TEXT_CONTRACTS).toHaveLength(77)
    expect(UNREQUIRED_SYNTHETIC_KINDS).toEqual([])
    // 15e.1a: the 2 tool_result kinds with a new call site are required.
    for (const k of ["tool_result.non_tool_result", "tool_result.invalid_input"] as const) {
      expect(TEXT_CONTRACTS).toContain(syntheticContract(k))
    }
    expect(REQUIRED_SYNTHETIC_KINDS).toContain("user_media.unavailable")
    // 15d.4 (spec Q11): the 3 compaction kinds are required.
    for (const k of [
      "compact.summary_system",
      "compact.tail_checkpoint",
      "compact.local_checkpoint",
    ] as const) {
      expect(REQUIRED_SYNTHETIC_KINDS).toContain(k)
      expect(TEXT_CONTRACTS).toContain(syntheticContract(k))
    }
    for (const k of UNREQUIRED_SYNTHETIC_KINDS) {
      expect(TEXT_CONTRACTS).not.toContain(syntheticContract(k))
    }
    expect(REQUIRED_SYNTHETIC_KINDS.length + UNREQUIRED_SYNTHETIC_KINDS.length).toBe(
      SYNTHETIC_KINDS.length,
    )
  })
})

describe("boot contract check (P3.5, F2)", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    for (const d of [EMBEDDED, USER, PROJECT]) mkdirSync(join(d, "plugins"), { recursive: true })
  })
  afterEach(() => {
    for (const d of [EMBEDDED, USER, PROJECT]) {
      rmSync(join(d, "plugins"), { recursive: true, force: true })
      mkdirSync(join(d, "plugins"), { recursive: true })
    }
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("passes with every text plugin, and derives text.system.* from the base manifest", async () => {
    textPlugins(EMBEDDED)
    const { loader, events } = await load()
    expect(loader.contractCheck()).toEqual({ missing: [], duplicates: [] })
    expect(bySource(events, "boot.contract_missing")).toHaveLength(0)
    expect(bySource(events, "boot.contract_duplicate")).toHaveLength(0)
  })

  it("fails with ContractCheckFailedError listing the contracts of an absent core-tools plugin", async () => {
    textPlugins(EMBEDDED, ["stub-tools"])
    const err = await load().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContractCheckFailedError)
    const e = err as ContractCheckFailedError
    expect(e.kind).toBe("ContractCheckFailedError")
    expect(e.message).toBe("")
    expect(e.duplicates).toEqual([])
    expect([...e.missing].sort()).toEqual(
      ["text.tools", ...TOOLS_KINDS.map(syntheticContract)].sort(),
    )
    expect(e.toJSON().fields.missing).toEqual([...e.missing])
  })

  it("fails when no plugin owns the 3 compact.* kinds (15d.4, spec Q11)", async () => {
    textPlugins(EMBEDDED, ["stub-recovery"])
    const noCompact = RECOVERY_KINDS.filter((k) => !k.startsWith("compact."))
    pkg(
      EMBEDDED,
      "stub-recovery",
      { required: true, syntheticText: [{ id: "s", entry: "./p.js", kinds: noCompact }] },
      { "p.js": synthProv(noCompact, "R") },
    )
    const err = await load().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContractCheckFailedError)
    expect([...(err as ContractCheckFailedError).missing].sort()).toEqual([
      "synthetic:compact.local_checkpoint",
      "synthetic:compact.summary_system",
      "synthetic:compact.tail_checkpoint",
    ])
  })

  it("a required core-tools plugin cannot be disabled away", async () => {
    textPlugins(EMBEDDED)
    const { loader } = await PluginLoader.load({
      roots: { embedded: [join(EMBEDDED, "plugins")] },
      logger: () => {},
      requiredContracts: TEXT_CONTRACTS,
      contractCheckMode: "fail",
      disabledPluginIds: new Set(["stub-tools"]),
    }).then((l) => ({ loader: l }))
    expect(loader.loadedPluginIds()).toContain("stub-tools")
  })

  it("warn mode records diagnostics and does not throw", async () => {
    textPlugins(EMBEDDED, ["stub-tools"])
    const { loader, events } = await load({ mode: "warn" })
    expect(loader.contractCheck().missing).toContain("text.tools")
    expect(bySource(events, "boot.contract_missing").length).toBe(1 + TOOLS_KINDS.length)
  })

  it("a project-tier override of one kind wins, with kind_overridden and no duplicate", async () => {
    textPlugins(EMBEDDED)
    const kind = "mode.change"
    pkg(
      PROJECT,
      "proj-mode",
      { syntheticText: [{ id: "s", entry: "./p.js", kinds: [kind] }] },
      { "p.js": synthProv([kind], "PROJECT-TEXT") },
    )
    const { loader, events } = await load()
    expect(loader.contractCheck()).toEqual({ missing: [], duplicates: [] })
    expect(bySource(events, "boot.contract_duplicate")).toHaveLength(0)
    expect(bySource(events, "synthetic.duplicate_owner")).toHaveLength(0)
    const over = bySource(events, "synthetic.kind_overridden")
    expect(over).toHaveLength(1)
    expect(over[0]?.message).toBe("")
    expect(over[0]?.structuredData).toEqual({
      contract: "synthetic:mode.change",
      owners: "proj-mode",
      overridden: "stub-tools",
    })
    expect(loader.syntheticText().resolve(kind, {})).toBe("PROJECT-TEXT")
    // The embedded owner keeps the kinds it was not overridden on.
    expect(loader.syntheticText().resolve("mode.refusal", {})).toBe("T")
  })

  it("a user-tier override of the identity wins over the embedded base", async () => {
    textPlugins(EMBEDDED)
    pkg(
      USER,
      "user-id",
      { systemPromptBase: { id: "u", entry: "./u.js", identity: true } },
      { "u.js": `export default () => ({ identity: () => "USER-ID" })` },
    )
    const { loader, events } = await load()
    expect(loader.contractCheck()).toEqual({ missing: [], duplicates: [] })
    expect(bySource(events, "prompt.system_base_slot_conflict")).toHaveLength(0)
    expect(bySource(events, "synthetic.kind_overridden")).toHaveLength(1)
    const id = resolveBaseIdentity(loader.systemPromptBase(), { authKind: "x", modelId: "m" })
    expect(id).toBe("USER-ID")
  })

  it("a project-tier tool text override wins and the embedded tool text is not used", async () => {
    textPlugins(EMBEDDED)
    pkg(
      PROJECT,
      "proj-tools",
      { toolText: [{ id: "t", entry: "./t.js", tools: ["Read"] }] },
      { "t.js": `export default () => ({ tools: ["Read"], tool: () => ({ description: "P" }) })` },
    )
    const { loader, events } = await load()
    expect(loader.contractCheck().duplicates).toEqual([])
    expect(bySource(events, "boot.contract_duplicate")).toHaveLength(0)
    expect(loader.toolTextProviders()).toHaveLength(1)
    expect(loader.toolTextProviders()[0]?.tool("Read")?.description).toBe("P")
  })

  it("two owners in the same tier are a duplicate and fail", async () => {
    textPlugins(EMBEDDED)
    pkg(
      EMBEDDED,
      "emb-mode",
      { syntheticText: [{ id: "s", entry: "./p.js", kinds: ["mode.change"] }] },
      { "p.js": synthProv(["mode.change"], "X") },
    )
    const err = await load().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContractCheckFailedError)
    expect((err as ContractCheckFailedError).duplicates).toEqual(["synthetic:mode.change"])
    expect((err as ContractCheckFailedError).missing).toEqual([])
  })

  it("allowBareCore with zero plugins skips the check", async () => {
    const { loader, events } = await load({ allowBareCore: true })
    expect(loader.loadedPluginIds()).toEqual([])
    expect(loader.contractCheck()).toEqual({ missing: [], duplicates: [] })
    expect(bySource(events, "boot.contract_missing")).toHaveLength(0)
  })
})

describe("bootHost requiredContracts", () => {
  const savedHome = process.env.MINIMAL_AGENT_HOME
  afterAll(() => {
    if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = savedHome
    rmSync(join(ROOT, "host"), { recursive: true, force: true })
  })

  it("throws ContractCheckFailedError without the text plugins", async () => {
    const home = join(ROOT, "host", "a")
    mkdirSync(join(home, "plugins"), { recursive: true })
    const err = await bootHost({
      home,
      pluginRoots: { user: [join(home, "plugins")] },
      requiredContracts: TEXT_CONTRACTS,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContractCheckFailedError)
    expect((err as ContractCheckFailedError).missing).toEqual([...TEXT_CONTRACTS])
  })

  it("allowBareCore boots with no check", async () => {
    const home = join(ROOT, "host", "b")
    mkdirSync(join(home, "plugins"), { recursive: true })
    const host = await bootHost({
      home,
      pluginRoots: { user: [join(home, "plugins")] },
      requiredContracts: TEXT_CONTRACTS,
      allowBareCore: true,
    })
    expect(host.plugins).toEqual([])
  })

  it("boots with the stub text plugins", async () => {
    const home = join(ROOT, "host", "c")
    textPlugins(home)
    const host = await bootHost({
      home,
      pluginRoots: { user: [join(home, "plugins")] },
      requiredContracts: TEXT_CONTRACTS,
    })
    expect(host.plugins.map((p) => p.id).sort()).toEqual([
      "stub-base",
      "stub-recovery",
      "stub-template",
      "stub-tools",
    ])
  })
})

const FIRST_PARTY = [
  "ma-base-prompt-plugin",
  "ma-core-tools-plugin",
  "ma-turn-recovery-plugin",
  "ma-prompt-template-plugin",
]

describe.skipIf(!FIRST_PARTY.every((p) => siblingPluginPresent(p)))(
  "first-party text plugins",
  () => {
    it("meet every TEXT_CONTRACTS entry", async () => {
      const loader = await PluginLoader.load({
        roots: { embedded: [SIBLING_REPO_ROOT] },
        logger: () => {},
        requiredContracts: TEXT_CONTRACTS,
        contractCheckMode: "warn",
      })
      expect(loader.contractCheck()).toEqual({ missing: [], duplicates: [] })
      for (const id of ["ma-base-prompt-plugin", "ma-core-tools-plugin", "turn-recovery"]) {
        expect(loader.loadedPluginIds()).toContain(id)
      }
    })
  },
)

describe("systemPromptBase contract data", () => {
  it("parses identity and slots, and rejects bad data", () => {
    expect(parseSystemPromptBaseData({ identity: true, slots: ["instructions"] })).toEqual({
      identity: true,
      slots: ["instructions"],
    })
    expect(parseSystemPromptBaseData({})).toEqual({ identity: false, slots: [] })
    expect(parseSystemPromptBaseData({ identity: "yes" })).toBeUndefined()
    expect(parseSystemPromptBaseData({ slots: ["nope"] })).toBeUndefined()
    expect(parseSystemPromptBaseData({ slots: ["instructions", "instructions"] })).toBeUndefined()
  })

  it("names the first bad field and the first bad slot", () => {
    expect(
      findSystemPromptBaseDataIssue({ identity: true, slots: ["instructions"] }),
    ).toBeUndefined()
    expect(findSystemPromptBaseDataIssue({})).toBeUndefined()
    expect(findSystemPromptBaseDataIssue([])).toEqual({ field: "systemPromptBase" })
    expect(findSystemPromptBaseDataIssue({ identity: "yes" })).toEqual({ field: "identity" })
    expect(findSystemPromptBaseDataIssue({ slots: "instructions" })).toEqual({ field: "slots" })
    expect(findSystemPromptBaseDataIssue({ slots: ["instructions", "nope", "x"] })).toEqual({
      field: "slots",
      slot: "nope",
    })
    expect(findSystemPromptBaseDataIssue({ slots: ["instructions", "instructions"] })).toEqual({
      field: "slots",
      slot: "instructions",
    })
  })

  it("derives text.system.* provides first", () => {
    const m = { id: "p", name: "p", version: "0", description: "d" } as unknown as ManifestFile
    const out = withDerivedProvides(m, { identity: true, slots: ["instructions"] })
    expect(out.provides).toEqual(["text.system.identity", "text.system.instructions"])
  })
})
