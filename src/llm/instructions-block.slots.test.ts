import { describe, expect, it } from "bun:test"

import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
} from "../plugins/system-prompt-base.ts"
import type { SystemPromptBaseProvider, SystemPromptSlot } from "../plugins/types.ts"

import { buildInstructionsBlockParts, buildInstructionsBlockText } from "./instructions-block.ts"

const OPTS = {
  reflectionInterval: 50,
  reflectionCooldownMs: 60_000,
  blobStoreEnabled: true,
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

const loopStub: SystemPromptBaseProvider = {
  slots: ["loopSafety"],
  instructionParts: (ctx) =>
    ctx === undefined || ctx.reflectionInterval === 0
      ? []
      : [
          {
            slot: "loopSafety",
            text: `LOOP ${ctx.reflectionInterval}/${ctx.reflectionCooldownMs}/${ctx.blobStoreEnabled}/${ctx.agentHome}`,
          },
        ],
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
      overrides: { toolOutputConventions: { kind: "replace", text: "OVR" } },
    })
    expect(out).toEqual([{ slot: "toolOutputConventions", text: "OVR", overridden: true }])
  })

  it("changes only the loopSafety slot, rendered from the ctx", () => {
    const others = fixedStub("instructions", "toolOutputConventions")
    const base = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith(fixedStub("loopSafety"), others),
    })
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith(loopStub, others),
    })
    expect(base.map((p) => p.slot)).toEqual(["instructions", "loopSafety", "toolOutputConventions"])
    expect(out.map((p) => p.slot)).toEqual(base.map((p) => p.slot))
    for (const [i, p] of out.entries()) {
      if (p.slot === "loopSafety") expect(p.text).toBe("LOOP 50/60000/true//agent/home")
      else expect(p.text).toBe(base[i]?.text ?? "")
    }
  })

  it("drops the slot when the provider returns no part", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      reflectionInterval: 0,
      systemPromptBase: holderWith(
        { slots: ["loopSafety", "toolOutputConventions"], instructionParts: () => [] },
        fixedStub("instructions"),
      ),
    })
    expect(out.map((p) => p.slot)).toEqual(["instructions"])
  })

  it("applies an override after the provider part", () => {
    const out = buildInstructionsBlockParts({
      ...OPTS,
      systemPromptBase: holderWith(loopStub),
      overrides: { loopSafety: { kind: "replace", text: "OVR" } },
    })
    const loop = out.find((p) => p.slot === "loopSafety")
    expect(loop?.text).toBe("OVR")
    expect(loop?.overridden).toBe(true)
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
      systemPromptBase: holderWith(
        { slots: ["loopSafety", "toolOutputConventions"] },
        fixedStub("instructions"),
      ),
    })
    expect(out.map((p) => p.slot)).toEqual(["instructions"])
  })
})
