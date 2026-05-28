import { describe, expect, it } from "bun:test"

import type { CanonicalMessage } from "./canonical-messages.ts"
import { type Capabilities, defaultCapabilities } from "./capabilities.ts"
import { modalityViolations } from "./modality-check.ts"

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
