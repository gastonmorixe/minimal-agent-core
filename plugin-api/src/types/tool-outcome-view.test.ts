import { describe, expect, it, test } from "bun:test"

import type { CanonicalMessage, ToolResultBlock } from "../llm/canonical-messages.ts"
import { type Capabilities, defaultCapabilities } from "../llm/capabilities.ts"
import { stripUnsupportedModalities, unsupportedAttachmentText } from "../llm/modality-check.ts"
import { viewPersistedOutcome } from "./tool-outcome-view.ts"

const TEXT = "ab\n\nNOTE"
const okOutcome = {
  v: 1,
  bodyEnd: 2,
  annotations: [{ kind: "output-truncated", start: 4, end: 8 }],
}

describe("viewPersistedOutcome", () => {
  it("gives the view of a valid record", () => {
    const view = viewPersistedOutcome([{ type: "text", text: TEXT }], {
      ...okOutcome,
      annotations: [
        { kind: "output-truncated", attrs: { n: 3, ok: true, s: "x" }, start: 4, end: 8 },
      ],
      data: { a: 1 },
    })
    expect(view).toEqual({
      text: TEXT,
      body: "ab",
      bodyEnd: 2,
      annotations: [
        {
          kind: "output-truncated",
          attrs: { n: 3, ok: true, s: "x" },
          start: 4,
          end: 8,
          text: "NOTE",
        },
      ],
      data: { a: 1 },
    })
  })

  it("accepts content as a string and has no data key when data is absent", () => {
    const view = viewPersistedOutcome(TEXT, okOutcome)
    expect(view?.body).toBe("ab")
    expect(view?.annotations[0]?.text).toBe("NOTE")
    expect(view && "data" in view).toBe(false)
  })

  it("accepts a record with no span when bodyEnd is the text length", () => {
    const view = viewPersistedOutcome("hello", { v: 1, bodyEnd: 5, annotations: [] })
    expect(view?.body).toBe("hello")
    expect(view?.annotations).toEqual([])
  })

  it("reads the first text block when an image comes first", () => {
    const content = [
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
      { type: "text", text: TEXT },
    ]
    const view = viewPersistedOutcome(content, okOutcome)
    expect(view?.text).toBe(TEXT)
    expect(view?.body).toBe("ab")
  })

  it("gives undefined for a version other than 1", () => {
    expect(viewPersistedOutcome(TEXT, { ...okOutcome, v: 2 })).toBeUndefined()
  })

  it("gives undefined when bodyEnd is out of range or not an integer", () => {
    expect(viewPersistedOutcome(TEXT, { ...okOutcome, bodyEnd: 9 })).toBeUndefined()
    expect(viewPersistedOutcome(TEXT, { ...okOutcome, bodyEnd: -1 })).toBeUndefined()
    expect(viewPersistedOutcome(TEXT, { ...okOutcome, bodyEnd: 1.5 })).toBeUndefined()
    expect(viewPersistedOutcome(TEXT, { ...okOutcome, bodyEnd: "2" })).toBeUndefined()
  })

  it("gives undefined for a bad span", () => {
    const view = (annotations: unknown[]) =>
      viewPersistedOutcome(TEXT, { v: 1, bodyEnd: 2, annotations })
    // end past the text
    expect(view([{ kind: "k", start: 4, end: 9 }])).toBeUndefined()
    // start after end
    expect(view([{ kind: "k", start: 6, end: 4 }])).toBeUndefined()
    // not integer
    expect(view([{ kind: "k", start: 4.5, end: 8 }])).toBeUndefined()
    // start before bodyEnd
    expect(view([{ kind: "k", start: 1, end: 8 }])).toBeUndefined()
    // empty span
    expect(view([{ kind: "k", start: 4, end: 4 }])).toBeUndefined()
    // kind missing
    expect(view([{ start: 4, end: 8 }])).toBeUndefined()
    // annotations not an array
    expect(viewPersistedOutcome(TEXT, { v: 1, bodyEnd: 2, annotations: {} })).toBeUndefined()
  })

  it("gives undefined when two spans overlap", () => {
    const annotations = [
      { kind: "a", start: 4, end: 7 },
      { kind: "b", start: 6, end: 8 },
    ]
    expect(viewPersistedOutcome(TEXT, { v: 1, bodyEnd: 2, annotations })).toBeUndefined()
  })

  it("gives undefined for no span when bodyEnd is less than the text length", () => {
    expect(viewPersistedOutcome(TEXT, { v: 1, bodyEnd: 2, annotations: [] })).toBeUndefined()
  })

  it("gives undefined for garbage input", () => {
    for (const bad of [undefined, null, 1, "x", [], true]) {
      expect(viewPersistedOutcome(TEXT, bad)).toBeUndefined()
    }
    expect(viewPersistedOutcome(undefined, okOutcome)).toBeUndefined()
    expect(viewPersistedOutcome(42, okOutcome)).toBeUndefined()
    expect(viewPersistedOutcome([null, 3, { type: "image" }], okOutcome)).toBeUndefined()
  })

  it("never throws for a hostile input with a throwing getter", () => {
    const hostile = {
      v: 1,
      get bodyEnd(): number {
        throw new Error("boom")
      },
      annotations: [],
    }
    expect(() => viewPersistedOutcome(TEXT, hostile)).not.toThrow()
    expect(viewPersistedOutcome(TEXT, hostile)).toBeUndefined()

    const hostileContent = [
      {
        type: "text",
        get text(): string {
          throw new Error("boom")
        },
      },
    ]
    expect(() => viewPersistedOutcome(hostileContent, okOutcome)).not.toThrow()
    expect(viewPersistedOutcome(hostileContent, okOutcome)).toBeUndefined()

    const hostileSpan = {
      v: 1,
      bodyEnd: 2,
      annotations: [
        {
          kind: "k",
          get start(): number {
            throw new Error("boom")
          },
          end: 8,
        },
      ],
    }
    expect(viewPersistedOutcome(TEXT, hostileSpan)).toBeUndefined()
  })
})

function textOnlyCaps(): Capabilities {
  return {
    ...defaultCapabilities(),
    modalities: { image: false, audio: false, pdf: false, video: false },
  }
}

const IMAGE = {
  type: "image",
  source: { kind: "base64", mediaType: "image/png", data: "AAAA" },
} as const

/** Strip one tool_result message for a text-only model and give the cleaned block. */
function stripToolResult(block: ToolResultBlock): ToolResultBlock {
  const msg: CanonicalMessage = { role: "user", content: [block] }
  const out = stripUnsupportedModalities([msg], textOnlyCaps(), "text-model")
  return out[0]?.content[0] as ToolResultBlock
}

// The CLI replay reads STORED content (no strip), so it never meets the
// placeholder. The strip runs inside the encoders (`anthropic-request.ts`,
// `openai-chat.ts`). This test proves that a reader that gets stripped content
// still does not trust the offsets (D8 rule 1).
test("an image-only tool result on a text-only model (D8 rule 1)", () => {
  // Case 1: image only. The strip makes the placeholder the first text block.
  const record = { v: 1 as const, bodyEnd: 0, annotations: [] }
  const cleaned = stripToolResult({
    type: "tool_result",
    toolUseId: "t1",
    content: [IMAGE],
    outcome: record,
  })
  const placeholder = unsupportedAttachmentText(IMAGE, "text-model")
  expect(cleaned.content).toEqual([placeholder])
  expect(cleaned.outcome).toEqual(record)
  // The guard: bodyEnd 0 is not the placeholder length, so there is no view.
  expect(viewPersistedOutcome(cleaned.content, cleaned.outcome)).toBeUndefined()

  // Case 2: text and image. The first text block is unchanged, so the view is valid.
  const record2 = {
    v: 1 as const,
    bodyEnd: 2,
    annotations: [{ kind: "output-truncated", start: 4, end: 8 }],
  }
  const cleaned2 = stripToolResult({
    type: "tool_result",
    toolUseId: "t2",
    content: [{ type: "text", text: TEXT }, IMAGE],
    outcome: record2,
  })
  expect(cleaned2.content).toEqual([{ type: "text", text: TEXT }, placeholder])
  expect(cleaned2.outcome).toEqual(record2)
  const view = viewPersistedOutcome(cleaned2.content, cleaned2.outcome)
  expect(view).toBeDefined()
  expect(view?.body).toBe("ab")
  expect(view?.annotations[0]?.text).toBe("NOTE")
})
