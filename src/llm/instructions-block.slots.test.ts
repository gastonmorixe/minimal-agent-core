import { describe, expect, it } from "bun:test"

import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
} from "../plugins/system-prompt-base.ts"
import type { SystemPromptBaseProvider, SystemPromptSlot } from "../plugins/types.ts"

import { buildInstructionsBlockParts, buildInstructionsBlockText } from "./instructions-block.ts"

const OPTS = {
  agentHome: "/agent/home",
}

function holderWith(provider: SystemPromptBaseProvider, ...others: SystemPromptBaseProvider[]) {
  const h = createSystemPromptBaseHolder()
  registerSystemPromptBase(h, "stub", provider)
  for (const [i, o] of others.entries()) registerSystemPromptBase(h, `other-${i}`, o)
  return h
}

/** A provider that owns `slots` with fixed text `<SLOT>` (core holds no slot text). */
function fixedStub(...slots: SystemPromptSlot[]): SystemPromptBaseProvider {
  return {
    slots,
    instructionParts: () => slots.map((slot) => ({ slot, text: slot.toUpperCase() })),
  }
}

describe("instructions block with a slots provider", () => {
  it("keeps the bytes with no provider (empty holder)", () => {
    const base = buildInstructionsBlockText(OPTS)
    const empty = buildInstructionsBlockText({
      ...OPTS,
      systemPromptBase: createSystemPromptBaseHolder(),
    })
    expect(empty).toBe(base)
  })

  it("with no provider every slot is off, and an override still applies", () => {
    expect(buildInstructionsBlockParts(OPTS)).toEqual([])
    const out = buildInstructionsBlockParts({
      ...OPTS,
      overrides: { instructions: { kind: "replace", text: "OVR" } },
    })
    expect(out).toEqual([{ slot: "instructions", text: "OVR", overridden: true }])
  })

  it("uses the provider part of the instructions slot", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith(fixedStub("instructions")),
    })
    expect(out).toEqual([{ slot: "instructions", text: "INSTRUCTIONS", overridden: false }])
  })

  it("drops the slot when the provider returns no part", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith({ slots: ["instructions"], instructionParts: () => [] }),
    })
    expect(out).toEqual([])
  })

  it("applies an override after the provider part", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith(fixedStub("instructions")),
      overrides: { instructions: { kind: "replace", text: "OVR" } },
    })
    expect(out).toEqual([{ slot: "instructions", text: "OVR", overridden: true }])
  })

  it("renders agentHome in a provider instructions part", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith({
        slots: ["instructions"],
        instructionParts: (ctx) => [{ slot: "instructions", text: `home=${ctx?.agentHome}` }],
      }),
    })
    expect(out[0]?.text).toBe("home=/agent/home")
  })

  it("does not render %%agentHome%% in the part of a provider with slots", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith({
        slots: ["instructions"],
        instructionParts: () => [{ slot: "instructions", text: "raw %%agentHome%%" }],
      }),
    })
    expect(out[0]?.text).toBe("raw %%agentHome%%")
  })

  it("renders %%agentHome%% in the part of an old-style provider (no slots)", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith({
        instructionParts: () => [{ slot: "instructions", text: "old %%agentHome%%" }],
      }),
    })
    expect(out[0]?.text).toBe("old /agent/home")
  })

  it("renders %%agentHome%% in opts.instructions even with a slots provider", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      instructions: "opt %%agentHome%%",
      systemPromptBase: holderWith({
        slots: ["instructions"],
        instructionParts: () => [{ slot: "instructions", text: "ignored" }],
      }),
    })
    expect(out[0]?.text).toBe("opt /agent/home")
  })

  it("turns off the declared slots of a provider with slots but no instructionParts", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith({ slots: ["instructions"] }),
    })
    expect(out).toEqual([])
  })
})
