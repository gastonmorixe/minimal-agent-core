import { describe, expect, it } from "bun:test"

import type { CanonicalMessage, TextBlock } from "./canonical-messages.ts"
import { type Capabilities, defaultCapabilities } from "./capabilities.ts"
import {
  isTextLikeMime,
  modalityViolations,
  stripUnsupportedModalities,
  unsupportedAttachmentText,
} from "./modality-check.ts"

const ph = (word: string, format: string, model = "this model"): TextBlock => ({
  type: "text",
  text: `[${word} attachment not sent: ${model} does not accept ${format}]`,
})

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

const videoMsg: CanonicalMessage = {
  role: "user",
  content: [{ type: "video", source: { kind: "base64", mediaType: "video/mp4", data: "AAAA" } }],
}

describe("modalityViolations", () => {
  it("gates video on the video flag", () => {
    expect(modalityViolations([videoMsg], caps({ video: false }), "m")).toHaveLength(1)
    expect(modalityViolations([videoMsg], caps({ video: true }), "m")).toHaveLength(0)
  })

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
      content: [{ type: "text", text: "an image:" }, imageMsg.content[0]!],
    },
  ]

  it("returns messages unchanged when all modalities are supported", () => {
    const result = stripUnsupportedModalities(mixed, caps({ image: true, audio: true, pdf: true }))
    expect(result).toEqual(mixed)
  })

  it("replaces image blocks with a placeholder when image is unsupported", () => {
    const result = stripUnsupportedModalities(mixed, caps({ image: false }), "m1")
    expect(result).toHaveLength(3)
    // textMsg unchanged
    expect(result[0]!.content).toEqual([{ type: "text", text: "hello" }])
    // imageMsg: the image becomes a placeholder
    expect(result[1]!.content).toEqual([ph("image", "image/png", "m1")])
    // mixed message: image replaced, text block remains
    expect(result[2]!.content).toEqual([
      { type: "text", text: "an image:" },
      ph("image", "image/png", "m1"),
    ])
  })

  it("replaces audio blocks", () => {
    const input: CanonicalMessage[] = [textMsg, audioMsg]
    const result = stripUnsupportedModalities(input, caps({ audio: false }))
    expect(result[0]!.content).toHaveLength(1) // text stays
    expect(result[1]!.content).toEqual([ph("audio", "audio/wav")])
  })

  it("replaces video blocks", () => {
    const result = stripUnsupportedModalities([videoMsg], caps({ video: false }))
    expect(result[0]!.content).toEqual([ph("video", "video/mp4")])
  })

  it("replaces file blocks when pdf is unsupported", () => {
    const result = stripUnsupportedModalities([fileMsg], caps({ pdf: false }))
    expect(result[0]!.content).toEqual([ph("file", "file_id reference")])
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
      ph("image", "image", "this model"),
    ])
  })

  it("keeps the tool_result when all inner blocks are replaced", () => {
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
    expect((toolResult as { content: unknown[] }).content).toEqual([ph("image", "image")])
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

describe("unsupportedAttachmentText", () => {
  it("names the kind, the format and the model, and keeps the cache hint", () => {
    expect(
      unsupportedAttachmentText(
        {
          type: "file",
          source: { kind: "base64", mediaType: "application/msword", data: "" },
          cache: { kind: "ephemeral" },
        },
        "gpt-x",
      ),
    ).toEqual({
      type: "text",
      text: "[file attachment not sent: gpt-x does not accept application/msword]",
      cache: { kind: "ephemeral" },
    })
  })
})

describe("isTextLikeMime", () => {
  it("accepts text/*, json, xml, yaml and suffix types", () => {
    for (const m of ["text/csv", "text/markdown", "application/json", "application/xml"]) {
      expect(isTextLikeMime(m)).toBe(true)
    }
    expect(isTextLikeMime("application/ld+json")).toBe(true)
    expect(isTextLikeMime("text/plain; charset=utf-8")).toBe(true)
  })
  it("rejects binary types", () => {
    expect(isTextLikeMime("application/pdf")).toBe(false)
    expect(isTextLikeMime("application/zip")).toBe(false)
    expect(isTextLikeMime("image/png")).toBe(false)
  })
})
