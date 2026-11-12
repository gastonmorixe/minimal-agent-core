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
    writeFileSync(join(PKG, "throws.ts"), `throw new TypeError("secret-detail-x")\n`)
    writeFileSync(
      join(PKG, "plain.ts"),
      `export default { instructionParts: () => [{ slot: "instructions", text: "p" }] }\n`,
    )
    writeFileSync(join(PKG, "factory.ts"), `export default () => ({ identity: () => "f" })\n`)
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  type Failure = { code: string; packageDir: string; abs: string; reason: string }

  async function run(entry: string, pluginId = "t") {
    const holder = createSystemPromptBaseHolder()
    const failures: Failure[] = []
    await loadSystemPromptBaseProvider({ id: "t", entry }, PKG, holder, pluginId, (f) =>
      failures.push(f),
    )
    return { holder, failures }
  }

  it("a missing entry file reports module_not_found and leaves the holder empty", async () => {
    const { holder, failures } = await run("./absent.ts")
    expect(holder.entries).toHaveLength(0)
    expect(failures).toEqual([
      { code: "module_not_found", packageDir: PKG, abs: join(PKG, "absent.ts"), reason: "" },
    ])
  })

  it("a string default export reports no_provider_export", async () => {
    const { holder, failures } = await run("./str.ts")
    expect(holder.entries).toHaveLength(0)
    expect(failures).toEqual([
      { code: "no_provider_export", packageDir: PKG, abs: join(PKG, "str.ts"), reason: "" },
    ])
  })

  it("an object with neither method reports no_provider_export", async () => {
    const { holder, failures } = await run("./empty.ts")
    expect(holder.entries).toHaveLength(0)
    expect(failures.map((f) => f.code)).toEqual(["no_provider_export"])
  })

  it("an import that throws reports load_failed with the error class and no message text", async () => {
    const { holder, failures } = await run("./throws.ts")
    expect(holder.entries).toHaveLength(0)
    expect(failures).toEqual([
      { code: "load_failed", packageDir: PKG, abs: join(PKG, "throws.ts"), reason: "TypeError" },
    ])
    expect(JSON.stringify(failures)).not.toContain("secret-detail-x")
  })

  it("a plain object and a factory are accepted", async () => {
    const a = await run("./plain.ts")
    expect(a.failures).toHaveLength(0)
    expect(collectSystemPromptParts(a.holder).get("instructions")).toBe("p")
    const b = await run("./factory.ts")
    expect(b.failures).toHaveLength(0)
    expect(resolveBaseIdentity(b.holder, { authKind: "a", modelId: "m" })).toBe("f")
  })

  it("a slot conflict goes to onConflict only, not to onFailure", async () => {
    const holder = createSystemPromptBaseHolder()
    const p: SystemPromptBaseProvider = parts("instructions", "first")
    registerSystemPromptBase(holder, "owner", p)
    const failures: Failure[] = []
    const seen: SystemPromptSlotConflictError[] = []
    await loadSystemPromptBaseProvider(
      { id: "t", entry: "./plain.ts" },
      PKG,
      holder,
      "t",
      (f) => failures.push(f),
      (e) => seen.push(e),
    )
    expect(holder.entries).toHaveLength(1)
    expect(failures).toHaveLength(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.slot).toBe("instructions")
    expect(seen[0]?.pluginIds).toEqual(["owner", "t"])
  })

  it("onConflict is not called for a load failure", async () => {
    const holder = createSystemPromptBaseHolder()
    const seen: SystemPromptSlotConflictError[] = []
    const failures: Failure[] = []
    await loadSystemPromptBaseProvider(
      { id: "t", entry: "./absent.ts" },
      PKG,
      holder,
      "t",
      (f) => failures.push(f),
      (e) => seen.push(e),
    )
    expect(seen).toHaveLength(0)
    expect(failures).toHaveLength(1)
  })

  it("an invalid raw value does nothing", async () => {
    const holder = createSystemPromptBaseHolder()
    const failures: Failure[] = []
    await loadSystemPromptBaseProvider(null, PKG, holder, "t", (f) => failures.push(f))
    expect(holder.entries).toHaveLength(0)
    expect(failures).toHaveLength(0)
  })
})
