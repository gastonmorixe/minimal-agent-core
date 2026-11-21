import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  installFixtureSystemPromptBase,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { buildInstructionsBlockParts, buildInstructionsBlockText } from "./instructions-block.ts"
import { describeSystemBlock, recordSystemBlock } from "./system-block-origins.ts"
import { buildAgentSystemBody, resolveSystemPromptForModel } from "./system-prompt.ts"

// The identity and the base slots come from the real base prompt plugin
// (process-wide slot, as the loader sets it), not from a core fallback.
let releaseBase = (): void => {}
beforeAll(() => {
  releaseBase = installFixtureSystemPromptBase()
})
afterAll(() => releaseBase())

/** Slice each span out of `text`, keyed by slot. */
function slices(text: string): Record<string, string> {
  const spans = describeSystemBlock(text) ?? []
  return Object.fromEntries(spans.map((s) => [s.slot, text.slice(s.start, s.end)]))
}

describe.skipIf(!textFixturesPresent())("system block origins", () => {
  it("instructions spans slice back to each part", () => {
    const opts = {
      instructions: "BASE_INSTRUCTIONS",
    }
    const parts = buildInstructionsBlockParts(opts)
    expect(parts.map((p) => p.slot)).toEqual(["instructions"])
    // The text builder is the join of the parts (byte-identical).
    expect(buildInstructionsBlockText(opts)).toBe(parts.map((p) => p.text).join("\n\n"))

    const [block] = buildAgentSystemBody(opts)
    expect(block.text).toBe(buildInstructionsBlockText(opts))
    const got = slices(block.text)
    for (const p of parts) expect(got[p.slot]).toBe(p.text)
    expect(describeSystemBlock(block.text)?.every((s) => !s.overridden)).toBe(true)
  })

  it("records the afterInstructions and sessionContext blocks", () => {
    const blocks = buildAgentSystemBody({
      instructions: "I",
      afterInstructions: "  AFTER_TEXT\n",
      sessionContext: "SESSION_TEXT",
    })
    expect(blocks.map((b) => b.text)).toEqual(["I", "AFTER_TEXT", "SESSION_TEXT"])
    expect(describeSystemBlock("AFTER_TEXT")).toEqual([
      { slot: "afterInstructions", start: 0, end: 10, overridden: false },
    ])
    expect(describeSystemBlock("SESSION_TEXT")).toEqual([
      { slot: "sessionContext", start: 0, end: 12, overridden: false },
    ])
  })

  it("records the identity text", () => {
    resolveSystemPromptForModel("no-such-model-origins", { identity: "IDENTITY_UNDER_TEST" })
    expect(describeSystemBlock("IDENTITY_UNDER_TEST")).toEqual([
      { slot: "identity", start: 0, end: 19, overridden: false },
    ])
    resolveSystemPromptForModel("no-such-model-origins", {
      overrides: { identity: { kind: "replace", text: "IDENTITY_OVERRIDE" } },
    })
    expect(describeSystemBlock("IDENTITY_OVERRIDE")?.[0]?.overridden).toBe(true)
  })

  it("an instructions override sets overridden", () => {
    const [block] = buildAgentSystemBody({
      overrides: { instructions: { kind: "replace", text: "OVERRIDDEN_BASE" } },
    })
    expect(describeSystemBlock(block.text)).toEqual([
      { slot: "instructions", start: 0, end: 15, overridden: true },
    ])
  })

  it("unknown text gives undefined", () => {
    expect(describeSystemBlock("never recorded text 8c1f")).toBeUndefined()
  })

  it("the 17th record evicts the first", () => {
    const span = { slot: "identity", start: 0, end: 1, overridden: false } as const
    for (let i = 0; i < 17; i++) recordSystemBlock(`evict-${i}`, [span])
    expect(describeSystemBlock("evict-0")).toBeUndefined()
    expect(describeSystemBlock("evict-1")).toEqual([span])
    expect(describeSystemBlock("evict-16")).toEqual([span])
  })

  // F4: two blocks with EQUAL text used to overwrite each other, so the host
  // reported the second block's slot for the first block too. Text is the only
  // lookup handle the exported API has, so the honest answer is "unrecorded".
  it("equal text in two slots reads back as ambiguous, not as the wrong slot", () => {
    const same = "SAME_TEXT_TWO_SLOTS"
    recordSystemBlock(same, [{ slot: "identity", start: 0, end: same.length, overridden: false }])
    recordSystemBlock(same, [
      { slot: "sessionContext", start: 0, end: same.length, overridden: false },
    ])
    expect(describeSystemBlock(same)).toBeUndefined()
    // Re-recording the same text with spans that already match adds no variant,
    // so an unambiguous block keeps its answer.
    const single = "ONE_SLOT_ONLY"
    recordSystemBlock(single, [
      { slot: "identity", start: 0, end: single.length, overridden: false },
    ])
    recordSystemBlock(single, [
      { slot: "identity", start: 0, end: single.length, overridden: false },
    ])
    expect(describeSystemBlock(single)).toEqual([
      { slot: "identity", start: 0, end: single.length, overridden: false },
    ])
  })

  // F4: the cap of 16 records bounds the count, not the bytes. The key now
  // stops at 4096 chars, so two texts that share their first 4096 chars and
  // differ only after that are not retained as distinct records.
  it("keeps at most 4096 chars of a block text as the key", () => {
    const head = "h".repeat(4096)
    const a = `${head}${"a".repeat(1000)}`
    const b = `${head}${"b".repeat(1000)}`
    recordSystemBlock(a, [{ slot: "identity", start: 0, end: a.length, overridden: false }])
    recordSystemBlock(b, [{ slot: "sessionContext", start: 0, end: b.length, overridden: false }])
    // One bounded key, two different span sets: ambiguous, so no slot is claimed.
    expect(describeSystemBlock(a)).toBeUndefined()
    expect(describeSystemBlock(b)).toBeUndefined()
  })
})
