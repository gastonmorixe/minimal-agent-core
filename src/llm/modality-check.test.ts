import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "./canonical-messages.ts"
import { type Capabilities, defaultCapabilities } from "./capabilities.ts"
import { modalityViolations, stripUnsupportedModalities } from "./modality-check.ts"

function caps(modalities: Partial<Capabilities["modalities"]>): Capabilities {
  return {
    ...defaultCapabilities(),
    modalities: { image: false, audio: false, pdf: false, video: false, ...modalities },
  }
}

const imageMsg: CanonicalMessage = {
  role: "user",
  content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } }],
}
const audioMsg: CanonicalMessage = {
  role: "user",
  content: [{ type: "audio", source: { kind: "base64", format: "wav", data: "AAAA" } }],
}
const fileMsg: CanonicalMessage = {
  role: "user",
  content: [{ type: "file", source: { kind: "file_id", fileId: "file_123" } }],
}

describe("modalityViolations", () => {
  it("flags image input when the model has no image modality", () => {
    const errs = modalityViolations([imageMsg], caps({ image: false }), "m")
    expect(errs).toHaveLength(1)
    expect(errs[0]?.capability).toBe("modalities")
  })

  it("passes image input when supported", () => {
    expect(modalityViolations([imageMsg], caps({ image: true }), "m")).toHaveLength(0)
  })

  it("gates audio and file (pdf) independently", () => {
    expect(modalityViolations([audioMsg], caps({ audio: false }), "m")).toHaveLength(1)
    expect(modalityViolations([audioMsg], caps({ audio: true }), "m")).toHaveLength(0)
    expect(modalityViolations([fileMsg], caps({ pdf: false }), "m")).toHaveLength(1)
    expect(modalityViolations([fileMsg], caps({ pdf: true }), "m")).toHaveLength(0)
  })

  it("inspects image blocks inside tool_result content", () => {
    const tr: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [{ type: "image", source: { kind: "url", url: "https://x/y.png" } }],
        },
      ],
    }
    expect(modalityViolations([tr], caps({ image: false }), "m")).toHaveLength(1)
  })

  it("returns no violations for a text-only request", () => {
    const textMsg: CanonicalMessage = { role: "user", content: [{ type: "text", text: "hi" }] }
    expect(modalityViolations([textMsg], caps({}), "m")).toHaveLength(0)
  })

  it("collects multiple violations across messages", () => {
    const errs = modalityViolations([imageMsg, audioMsg, fileMsg], caps({}), "m")
    expect(errs).toHaveLength(3)
  })
})

describe("stripUnsupportedModalities", () => {
  const textMsg: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: "hello" }],
  }
  const mixed: CanonicalMessage[] = [
    textMsg,
    imageMsg,
    {
      role: "user",
      content: [
        { type: "text", text: "an image:" },
        imageMsg.content[0]!,
      ],
    },
  ]

  it("returns messages unchanged when all modalities are supported", () => {
    const result = stripUnsupportedModalities(mixed, caps({ image: true, audio: true, pdf: true }))
    expect(result).toEqual(mixed)
  })

  it("removes image blocks when image is unsupported", () => {
    const result = stripUnsupportedModalities(mixed, caps({ image: false }))
    expect(result).toHaveLength(3)
    // textMsg unchanged
    expect(result[0]!.content).toEqual([{ type: "text", text: "hello" }])
    // imageMsg stripped — empty content array
    expect(result[1]!.content).toHaveLength(0)
    // mixed message: image block stripped, text block remains
    expect(result[2]!.content).toEqual([{ type: "text", text: "an image:" }])
  })

  it("removes audio blocks", () => {
    const input: CanonicalMessage[] = [textMsg, audioMsg]
    const result = stripUnsupportedModalities(input, caps({ audio: false }))
    expect(result[0]!.content).toHaveLength(1) // text stays
    expect(result[1]!.content).toHaveLength(0) // audio stripped
  })

  it("removes file blocks when pdf is unsupported", () => {
    const result = stripUnsupportedModalities([fileMsg], caps({ pdf: false }))
    expect(result[0]!.content).toHaveLength(0)
  })

  it("removes image blocks inside tool_result content", () => {
    const tr: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [
            { type: "text", text: "result text" },
            { type: "image", source: { kind: "url", url: "https://x/y.png" } },
          ],
        },
      ],
    }
    const result = stripUnsupportedModalities([tr], caps({ image: false }))
    const toolResult = result[0]!.content[0]!
    expect(toolResult.type).toBe("tool_result")
    // tool_result block is still present (pairing preserved)
    expect((toolResult as { content: unknown[] }).content).toEqual([
      { type: "text", text: "result text" },
    ])
  })

  it("preserves empty tool_result when all inner blocks are stripped", () => {
    const tr: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "t1",
          content: [{ type: "image", source: { kind: "url", url: "https://x/y.png" } }],
        },
      ],
    }
    const result = stripUnsupportedModalities([tr], caps({ image: false }))
    const toolResult = result[0]!.content[0]!
    expect(toolResult.type).toBe("tool_result")
    expect((toolResult as { content: unknown[] }).content).toEqual([])
  })

  it("strips nothing when all caps match", () => {
    const input: CanonicalMessage[] = [textMsg, imageMsg]
    const result = stripUnsupportedModalities(input, caps({ image: true, audio: true, pdf: true }))
    // identity for text, keep image
    expect(result).toEqual(input)
  })

  it("returns a new array (does not mutate)", () => {
    const result = stripUnsupportedModalities(mixed, caps({ image: false }))
    expect(result).not.toBe(mixed)
    expect(result[0]).not.toBe(mixed[0])
    expect(mixed[1]!.content).toHaveLength(1) // original untouched
  })
})
