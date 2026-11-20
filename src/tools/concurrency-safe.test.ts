/**
 * The concurrency-safe resolver: built-in flags, the plugin manifest flag,
 * the per-input export, and `interactive: true` forces a serial call.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  CORE_TOOLS,
  TOOL_HANDLER_BODY,
  toolManifest,
  writePackage,
} from "../plugins/loader.fixtures.ts"
import { PluginLoader } from "../plugins/loader.ts"

import {
  createConcurrencySafeResolver,
  type PluginToolConcurrency,
  runPerInputCheck,
  SERIAL_ONLY_RESOLVER,
} from "./concurrency-safe.ts"
import { BUILTIN_TOOL_NAMES, CONCURRENCY_SAFE_BUILTIN_TOOLS } from "./tools.ts"

describe("built-in tool flags", () => {
  it("Read, Glob, Grep and FilesStats are concurrency-safe; all others are serial", () => {
    expect([...CONCURRENCY_SAFE_BUILTIN_TOOLS].sort()).toEqual([
      "FilesStats",
      "Glob",
      "Grep",
      "Read",
    ])
    const r = createConcurrencySafeResolver(null)
    for (const name of BUILTIN_TOOL_NAMES) {
      const safe = CONCURRENCY_SAFE_BUILTIN_TOOLS.has(name)
      expect(r.toolFlag(name)).toEqual({ flag: safe })
      expect(r.isCallConcurrencySafe(name, {})).toBe(safe)
    }
    for (const name of ["Bash", "Edit", "Write", "Mode"]) {
      expect(r.toolFlag(name).flag).toBe(false)
    }
  })

  it("an unknown tool is a serial call", () => {
    const r = createConcurrencySafeResolver(null)
    expect(r.toolFlag("Nope")).toEqual({ flag: false })
    expect(r.isCallConcurrencySafe("Nope", {})).toBe(false)
  })

  it("SERIAL_ONLY_RESOLVER gives a serial call for each tool", () => {
    expect(SERIAL_ONLY_RESOLVER.toolFlag("Read")).toEqual({ flag: false })
    expect(SERIAL_ONLY_RESOLVER.isCallConcurrencySafe("Read", {})).toBe(false)
  })
})

describe("runPerInputCheck", () => {
  it("only true makes the call concurrency-safe; a throw is false", () => {
    expect(runPerInputCheck(() => true, {})).toBe(true)
    expect(runPerInputCheck(() => false, {})).toBe(false)
    expect(runPerInputCheck(() => 1 as unknown as boolean, {})).toBe(false)
    expect(
      runPerInputCheck(() => {
        throw new Error("boom")
      }, {}),
    ).toBe(false)
  })
})

describe("plugin tools (stub source)", () => {
  const source = (facts: Record<string, PluginToolConcurrency>) => ({
    hasTool: (n: string) => n in facts,
    toolConcurrency: (n: string) => facts[n],
  })

  it("the manifest flag gives the tool flag; no export means safe for each input", () => {
    const r = createConcurrencySafeResolver(source({ Fetch: { flag: true } }))
    expect(r.toolFlag("Fetch")).toEqual({ flag: true })
    expect(r.isCallConcurrencySafe("Fetch", { url: "x" })).toBe(true)
  })

  it("the per-input export decides after admission (true, false, throw)", () => {
    const perInput = (input: Record<string, unknown>) => {
      if (input.mode === "throw") throw new Error("bad")
      return !input.session
    }
    const r = createConcurrencySafeResolver(source({ Fetch: { flag: true, perInput } }))
    expect(r.toolFlag("Fetch")).toEqual({ flag: true })
    expect(r.isCallConcurrencySafe("Fetch", {})).toBe(true)
    expect(r.isCallConcurrencySafe("Fetch", { session: "s1" })).toBe(false)
    expect(r.isCallConcurrencySafe("Fetch", { mode: "throw" })).toBe(false)
  })

  it("the per-input export cannot make a tool without the flag concurrency-safe", () => {
    const r = createConcurrencySafeResolver(source({ T: { flag: false, perInput: () => true } }))
    expect(r.toolFlag("T")).toEqual({ flag: false })
    expect(r.isCallConcurrencySafe("T", {})).toBe(false)
  })

  it("a plugin tool wins over a built-in tool with the same name", () => {
    const r = createConcurrencySafeResolver(source({ Read: { flag: false } }))
    expect(r.toolFlag("Read")).toEqual({ flag: false })
    expect(r.isCallConcurrencySafe("Read", {})).toBe(false)
  })

  it("a loader stub without toolConcurrency makes its tools serial", () => {
    const r = createConcurrencySafeResolver({ hasTool: (n: string) => n === "X" })
    expect(r.toolFlag("X")).toEqual({ flag: false })
    expect(r.isCallConcurrencySafe("X", {})).toBe(false)
    expect(r.toolFlag("Read")).toEqual({ flag: true })
  })
})

describe("plugin tools (real loader)", () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ma-concurrency-safe-"))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function pkg(
    id: string,
    toolName: string,
    opts: { flag?: unknown; interactive?: boolean; handler?: string; aliases?: string[] },
  ): void {
    const m = toolManifest(id, toolName, "./h.ts")
    const entry = m.headless.tools[0] as unknown as {
      interactive: boolean
      trigger: { tool: Record<string, unknown> }
    }
    if (opts.flag !== undefined) entry.trigger.tool.concurrencySafe = opts.flag
    if (opts.aliases) entry.trigger.tool.aliases = opts.aliases
    if (opts.interactive !== undefined) entry.interactive = opts.interactive
    writePackage(root, id, m, { "h.ts": opts.handler ?? TOOL_HANDLER_BODY })
  }

  const PER_INPUT_HANDLER = `${TOOL_HANDLER_BODY}
export function concurrencySafe(input) {
  if (input.boom) throw new Error("boom")
  return input.ok === true
}
`

  it("reads the manifest flag, the per-input export and interactive", async () => {
    pkg("p-safe", "SafeTool", { flag: true, aliases: ["SafeOld"] })
    pkg("p-serial", "SerialTool", {})
    pkg("p-input", "InputTool", { flag: true, handler: PER_INPUT_HANDLER })
    pkg("p-inter", "InterTool", { flag: true, interactive: true })
    pkg("p-noflag", "NoFlagTool", { handler: PER_INPUT_HANDLER })
    const loader = await PluginLoader.load({
      userDir: root,
      roots: { project: [join(root, "nope")] },
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.hasTool("SafeTool")).toBe(true)
    const r = createConcurrencySafeResolver(loader)

    expect(r.toolFlag("SafeTool")).toEqual({ flag: true })
    expect(r.isCallConcurrencySafe("SafeTool", {})).toBe(true)
    // An alias resolves to the canonical handler.
    expect(r.toolFlag("SafeOld")).toEqual({ flag: true })

    expect(r.toolFlag("SerialTool")).toEqual({ flag: false })
    expect(r.isCallConcurrencySafe("SerialTool", {})).toBe(false)

    expect(r.toolFlag("InputTool")).toEqual({ flag: true })
    expect(r.isCallConcurrencySafe("InputTool", { ok: true })).toBe(true)
    expect(r.isCallConcurrencySafe("InputTool", { ok: false })).toBe(false)
    expect(r.isCallConcurrencySafe("InputTool", { boom: true })).toBe(false)

    // interactive: true is always a serial call, also with the flag.
    expect(r.toolFlag("InterTool")).toEqual({ flag: false })
    expect(r.isCallConcurrencySafe("InterTool", {})).toBe(false)

    // The export alone does not opt in.
    expect(r.toolFlag("NoFlagTool")).toEqual({ flag: false })
    expect(r.isCallConcurrencySafe("NoFlagTool", { ok: true })).toBe(false)

    expect(loader.toolConcurrency("Missing")).toBeUndefined()
    expect(typeof loader.toolConcurrency("InputTool")?.perInput).toBe("function")
  })
})
