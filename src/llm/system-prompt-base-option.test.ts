import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { PromptContributorAdapter } from "../adapters/prompt-contributor-adapter.ts"
import { DEFAULT_REFLECTION_COOLDOWN_MS, DEFAULT_REFLECTION_INTERVAL } from "../agent/reflection.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
  type SystemPromptBaseHolder,
} from "../plugins/system-prompt-base.ts"

import { renderInstructions } from "./instructions-block.ts"
import { type ResolveSystemPromptOptions, resolveSystemPromptForModel } from "./system-prompt.ts"
import { clearSystemPromptBase, setSystemPromptBase } from "./system-prompt-base-registry.ts"

const MODEL = "base-option-unregistered-model"
const PROMPTS = join(import.meta.dir, "..", "prompts")
const IDENTITY = readFileSync(join(PROMPTS, "identity.neutral.md"), "utf8").trim()
// The file is a template. Render it as core does, so the text matches the system array.
const INSTRUCTIONS = renderInstructions(
  readFileSync(join(PROMPTS, "instructions.md"), "utf8").trim(),
)
const BASE = {
  reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
  reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
  authKind: "api-key",
} as const

function holderOf(identity: string, instructions: string): SystemPromptBaseHolder {
  const holder = createSystemPromptBaseHolder()
  registerSystemPromptBase(holder, "stub", {
    identity: () => identity,
    instructionParts: () => [{ slot: "instructions", text: instructions }],
  })
  return holder
}

const json = (o: ResolveSystemPromptOptions): string =>
  JSON.stringify(resolveSystemPromptForModel(MODEL, o))
const bytes = (o: ResolveSystemPromptOptions) => Buffer.from(json(o), "utf8")

describe("resolveSystemPromptForModel systemPromptBase option", () => {
  afterEach(() => clearSystemPromptBase())

  test("the option wins over the global registry", () => {
    setSystemPromptBase(holderOf("B-id", "B-ins"))
    const text = json({ ...BASE, systemPromptBase: holderOf("A-id", "A-ins") })
    expect(text).toContain("A-id")
    expect(text).toContain("A-ins")
    expect(text).not.toContain("B-id")
    expect(text).not.toContain("B-ins")
  })

  test("with no option the registry is the fallback", () => {
    setSystemPromptBase(holderOf("B-id", "B-ins"))
    const text = json({ ...BASE })
    expect(text).toContain("B-id")
    expect(text).toContain("B-ins")
  })

  test("with neither the core defaults apply", () => {
    const text = json({ ...BASE })
    expect(text).toContain(JSON.stringify(IDENTITY).slice(1, -1))
    expect(text).toContain(JSON.stringify(INSTRUCTIONS).slice(1, -1))
  })

  test("an option with the exact asset bytes equals no holder", () => {
    const empty = bytes({ ...BASE })
    const withOption = bytes({ ...BASE, systemPromptBase: holderOf(IDENTITY, INSTRUCTIONS) })
    expect(withOption.equals(empty)).toBe(true)
  })
})

describe("two hosts with different plugin sets and no global", () => {
  afterEach(() => clearSystemPromptBase())

  async function host(holder: SystemPromptBaseHolder | undefined) {
    const loader = (holder ? { systemPromptBase: () => holder } : {}) as unknown as PluginLoader
    return PromptContributorAdapter.create({ loader })
  }

  test("each host gets its own base", async () => {
    const hostA = await host(holderOf("A-id", "A-ins"))
    const hostB = await host(undefined)
    const defaults = bytes({ ...BASE })

    const forA = JSON.stringify(
      resolveSystemPromptForModel(MODEL, { ...BASE, systemPromptBase: hostA.systemPromptBase() }),
    )
    const forB = Buffer.from(
      JSON.stringify(
        resolveSystemPromptForModel(MODEL, { ...BASE, systemPromptBase: hostB.systemPromptBase() }),
      ),
      "utf8",
    )
    expect(forA).toContain("A-id")
    expect(forA).toContain("A-ins")
    expect(forB.equals(defaults)).toBe(true)
  })

  test("with the global set to A, host B with an empty holder keeps the core default bytes", async () => {
    const hostA = await host(holderOf("A-id", "A-ins"))
    const hostB = await host(createSystemPromptBaseHolder())
    const defaults = bytes({ ...BASE })
    const holderA = hostA.systemPromptBase()
    if (holderA === undefined) throw new Error("holder missing")
    setSystemPromptBase(holderA)
    const forB = Buffer.from(
      JSON.stringify(
        resolveSystemPromptForModel(MODEL, { ...BASE, systemPromptBase: hostB.systemPromptBase() }),
      ),
      "utf8",
    )
    expect(forB.equals(defaults)).toBe(true)
  })

  test("with the global set to A, a host with an undefined option falls back to A (interim)", async () => {
    const hostA = await host(holderOf("A-id", "A-ins"))
    const hostB = await host(undefined)
    const holderA = hostA.systemPromptBase()
    if (holderA === undefined) throw new Error("holder missing")
    setSystemPromptBase(holderA)
    const forB = JSON.stringify(
      resolveSystemPromptForModel(MODEL, { ...BASE, systemPromptBase: hostB.systemPromptBase() }),
    )
    // Interim fallback that the later step removes: the option of this host
    // is undefined, so the global registry applies.
    expect(forB).toContain("A-id")
  })
})
