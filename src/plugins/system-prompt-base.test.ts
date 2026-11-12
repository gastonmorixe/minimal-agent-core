import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  collectSystemPromptParts,
  createSystemPromptBaseHolder,
  loadSystemPromptBaseProvider,
  parseSystemPromptBaseRaw,
  registerSystemPromptBase,
  resolveBaseIdentity,
  SystemPromptSlotConflictError,
} from "./system-prompt-base.ts"
import type { SystemPromptBaseProvider } from "./types.ts"

const ROOT = resolve(__dirname, "../../tmp/system-prompt-base-tests")
const PKG = join(ROOT, "pkg")

const parts = (slot: "instructions" | "loopSafety" | "toolOutputConventions", text: string) => ({
  instructionParts: () => [{ slot, text }],
})

describe("parseSystemPromptBaseRaw", () => {
  it("accepts {id, entry} and drops extras", () => {
    expect(parseSystemPromptBaseRaw({ id: "b", entry: "./p.ts", extra: 1 })).toEqual({
      id: "b",
      entry: "./p.ts",
    })
  })
  it("rejects missing id, empty entry, array, null", () => {
    for (const bad of [{ entry: "./p.ts" }, { id: "b", entry: "" }, [], null, "x", undefined]) {
      expect(parseSystemPromptBaseRaw(bad)).toBeUndefined()
    }
  })
})

describe("registerSystemPromptBase", () => {
  it("accepts two providers on different slots", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", parts("instructions", "x"))
    registerSystemPromptBase(h, "b", parts("loopSafety", "y"))
    expect(h.entries).toHaveLength(2)
  })

  it("refuses a second provider on the same slot", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", parts("instructions", "x"))
    let err: unknown
    try {
      registerSystemPromptBase(h, "b", parts("instructions", "z"))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SystemPromptSlotConflictError)
    const c = err as SystemPromptSlotConflictError
    expect(c.slot).toBe("instructions")
    expect(c.pluginIds).toEqual(["a", "b"])
    expect(c.kind).toBe("SystemPromptSlotConflictError")
    expect(h.entries).toHaveLength(1)
  })

  it("refuses the same slot twice inside one provider", () => {
    const h = createSystemPromptBaseHolder()
    let err: unknown
    try {
      registerSystemPromptBase(h, "a", {
        instructionParts: () => [
          { slot: "instructions", text: "one" },
          { slot: "instructions", text: "two" },
        ],
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SystemPromptSlotConflictError)
    const c = err as SystemPromptSlotConflictError
    expect(c.slot).toBe("instructions")
    expect(c.pluginIds).toEqual(["a", "a"])
    expect(h.entries).toHaveLength(0)
  })

  it("accepts different slots inside one provider", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", {
      instructionParts: () => [
        { slot: "instructions", text: "one" },
        { slot: "loopSafety", text: "two" },
      ],
    })
    expect(h.entries).toHaveLength(1)
  })

  it("refuses a second identity provider", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", { identity: () => "i1" })
    expect(() => registerSystemPromptBase(h, "b", { identity: () => "i2" })).toThrow(
      SystemPromptSlotConflictError,
    )
    expect(h.entries).toHaveLength(1)
  })
})

describe("collect and resolve", () => {
  it("collects the parts per slot by name", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", parts("instructions", "x"))
    registerSystemPromptBase(h, "b", {
      instructionParts: () => [
        { slot: "toolOutputConventions", text: "t" },
        { slot: "loopSafety", text: "l" },
      ],
    })
    const m = collectSystemPromptParts(h)
    expect(m.get("instructions")).toBe("x")
    expect(m.get("loopSafety")).toBe("l")
    expect(m.get("toolOutputConventions")).toBe("t")
    expect(m.size).toBe(3)
  })

  it("reads parts lazily at collect time", () => {
    const h = createSystemPromptBaseHolder()
    let text = "one"
    registerSystemPromptBase(h, "a", { instructionParts: () => [{ slot: "instructions", text }] })
    text = "two"
    expect(collectSystemPromptParts(h).get("instructions")).toBe("two")
  })

  it("passes authKind and modelId to identity", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", { identity: (c) => `${c.authKind}|${c.modelId}` })
    expect(resolveBaseIdentity(h, { authKind: "k", modelId: "m" })).toBe("k|m")
  })

  it("returns undefined with no identity provider", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", parts("instructions", "x"))
    expect(resolveBaseIdentity(h, { authKind: "k", modelId: "m" })).toBeUndefined()
    expect(collectSystemPromptParts(createSystemPromptBaseHolder()).size).toBe(0)
  })
})

describe("loadSystemPromptBaseProvider", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(PKG, { recursive: true })
    writeFileSync(join(PKG, "str.ts"), `export default "no"\n`)
    writeFileSync(join(PKG, "empty.ts"), `export default { other: 1 }\n`)
    writeFileSync(
      join(PKG, "plain.ts"),
      `export default { instructionParts: () => [{ slot: "instructions", text: "p" }] }\n`,
    )
    writeFileSync(join(PKG, "factory.ts"), `export default () => ({ identity: () => "f" })\n`)
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  async function run(entry: string, pluginId = "t") {
    const holder = createSystemPromptBaseHolder()
    const logs: string[] = []
    await loadSystemPromptBaseProvider({ id: "t", entry }, PKG, holder, pluginId, (m) =>
      logs.push(m),
    )
    return { holder, logs }
  }

  it("a missing entry file logs and leaves the holder empty", async () => {
    const { holder, logs } = await run("./absent.ts")
    expect(holder.entries).toHaveLength(0)
    expect(logs[0]).toContain("module not found")
  })

  it("a string default export is refused", async () => {
    const { holder, logs } = await run("./str.ts")
    expect(holder.entries).toHaveLength(0)
    expect(logs[0]).toContain("no provider export")
  })

  it("an object with neither method is refused", async () => {
    const { holder, logs } = await run("./empty.ts")
    expect(holder.entries).toHaveLength(0)
    expect(logs[0]).toContain("no provider export")
  })

  it("a plain object and a factory are accepted", async () => {
    const a = await run("./plain.ts")
    expect(a.logs).toHaveLength(0)
    expect(collectSystemPromptParts(a.holder).get("instructions")).toBe("p")
    const b = await run("./factory.ts")
    expect(b.logs).toHaveLength(0)
    expect(resolveBaseIdentity(b.holder, { authKind: "a", modelId: "m" })).toBe("f")
  })

  it("a slot conflict is logged and leaves the holder unchanged", async () => {
    const holder = createSystemPromptBaseHolder()
    const logs: string[] = []
    const p: SystemPromptBaseProvider = parts("instructions", "first")
    registerSystemPromptBase(holder, "owner", p)
    await loadSystemPromptBaseProvider({ id: "t", entry: "./plain.ts" }, PKG, holder, "t", (m) =>
      logs.push(m),
    )
    expect(holder.entries).toHaveLength(1)
    expect(logs).toHaveLength(1)
  })

  it("a slot conflict calls onConflict with the slot and ids, other failures do not", async () => {
    const holder = createSystemPromptBaseHolder()
    registerSystemPromptBase(holder, "owner", parts("instructions", "first"))
    const seen: SystemPromptSlotConflictError[] = []
    const log = () => undefined
    const cb = (e: SystemPromptSlotConflictError) => seen.push(e)
    await loadSystemPromptBaseProvider({ id: "t", entry: "./plain.ts" }, PKG, holder, "t", log, cb)
    await loadSystemPromptBaseProvider({ id: "t", entry: "./absent.ts" }, PKG, holder, "t", log, cb)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.slot).toBe("instructions")
    expect(seen[0]?.pluginIds).toEqual(["owner", "t"])
  })

  it("an invalid raw value does nothing", async () => {
    const holder = createSystemPromptBaseHolder()
    const logs: string[] = []
    await loadSystemPromptBaseProvider(null, PKG, holder, "t", (m) => logs.push(m))
    expect(holder.entries).toHaveLength(0)
    expect(logs).toHaveLength(0)
  })
})
