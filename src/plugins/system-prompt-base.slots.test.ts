import { describe, expect, it } from "bun:test"

import {
  collectSystemPromptParts,
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
  SystemPromptSlotConflictError,
} from "./system-prompt-base.ts"
import type { SystemPromptPartsContext } from "./types.ts"

const CTX: SystemPromptPartsContext = {
  blobStoreEnabled: true,
  agentHome: "/home/x",
}

describe("provider with data slots", () => {
  it("is not called at register time", () => {
    const h = createSystemPromptBaseHolder()
    let calls = 0
    registerSystemPromptBase(h, "a", {
      slots: ["toolOutputConventions"],
      instructionParts: () => {
        calls += 1
        return []
      },
    })
    expect(calls).toBe(0)
    expect(h.entries[0]?.slots).toEqual(["toolOutputConventions"])
  })

  it("conflicts by the declared slots", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", {
      slots: ["toolOutputConventions"],
      instructionParts: () => [],
    })
    let err: unknown
    try {
      registerSystemPromptBase(h, "b", {
        slots: ["toolOutputConventions"],
        instructionParts: () => [],
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SystemPromptSlotConflictError)
    expect((err as SystemPromptSlotConflictError).pluginIds).toEqual(["a", "b"])
    expect(h.entries).toHaveLength(1)
  })

  it("conflicts with an old-style provider on the same slot", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "old", {
      instructionParts: () => [{ slot: "instructions", text: "x" }],
    })
    expect(() =>
      registerSystemPromptBase(h, "new", {
        slots: ["instructions"],
        instructionParts: () => [],
      }),
    ).toThrow(SystemPromptSlotConflictError)
  })

  it("refuses a duplicate slot in the data list", () => {
    const h = createSystemPromptBaseHolder()
    expect(() =>
      registerSystemPromptBase(h, "a", {
        slots: ["toolOutputConventions", "toolOutputConventions"],
        instructionParts: () => [],
      }),
    ).toThrow(SystemPromptSlotConflictError)
    expect(h.entries).toHaveLength(0)
  })

  it("gets the ctx at each collect, and an absent part means off", () => {
    const h = createSystemPromptBaseHolder()
    const seen: unknown[] = []
    registerSystemPromptBase(h, "a", {
      slots: ["toolOutputConventions"],
      instructionParts: (ctx) => {
        seen.push(ctx)
        return [
          { slot: "toolOutputConventions", text: `home ${ctx?.agentHome}` },
          { slot: "instructions", text: "undeclared" },
        ]
      },
    })
    const m = collectSystemPromptParts(h, CTX)
    collectSystemPromptParts(h, CTX)
    expect(seen).toEqual([CTX, CTX])
    expect(m.get("toolOutputConventions")).toBe("home /home/x")
    expect(m.has("instructions")).toBe(false)
    const h2 = createSystemPromptBaseHolder()
    registerSystemPromptBase(h2, "b", {
      slots: ["instructions", "toolOutputConventions"],
      instructionParts: () => [{ slot: "instructions", text: "i" }],
    })
    const m2 = collectSystemPromptParts(h2, CTX)
    expect(m2.get("instructions")).toBe("i")
    expect(m2.get("toolOutputConventions")).toBe("")
  })

  it("keeps the old call shape for a provider with no slots", () => {
    const h = createSystemPromptBaseHolder()
    const seen: unknown[][] = []
    registerSystemPromptBase(h, "a", {
      instructionParts: (...args: unknown[]) => {
        seen.push(args)
        return [{ slot: "instructions", text: "x" }]
      },
    })
    expect(seen).toEqual([[]])
    expect(collectSystemPromptParts(h, CTX).get("instructions")).toBe("x")
    expect(seen).toEqual([[], []])
  })

  it("maps the declared slots to off when the provider has no instructionParts", () => {
    const h = createSystemPromptBaseHolder()
    registerSystemPromptBase(h, "a", {
      slots: ["toolOutputConventions"],
      identity: () => "id",
    })
    const m = collectSystemPromptParts(h, CTX)
    expect(m.get("toolOutputConventions")).toBe("")
    expect(m.has("instructions")).toBe(false)
  })
})
