import { describe, expect, it } from "bun:test"

import { defaultCapabilities, mimeModality, resolveInputMimeTypes } from "./capabilities.ts"

const DEFAULTS = ["image/png", "image/jpeg", "application/pdf", "text/plain", "audio/wav"]

describe("resolveInputMimeTypes", () => {
  it("uses the model's declared list when present", () => {
    const caps = { ...defaultCapabilities(), inputMimeTypes: ["image/PNG", "video/mp4"] }
    expect(resolveInputMimeTypes(caps, DEFAULTS)).toEqual(["image/png", "video/mp4"])
  })

  it("derives the list from the modality flags when absent", () => {
    const caps = {
      ...defaultCapabilities(),
      modalities: { image: true, audio: false, pdf: false, video: false },
    }
    expect(resolveInputMimeTypes(caps, DEFAULTS)).toEqual(["image/png", "image/jpeg"])
  })

  it("maps document types to the pdf flag", () => {
    const caps = {
      ...defaultCapabilities(),
      modalities: { image: false, audio: true, pdf: true, video: false },
    }
    expect(resolveInputMimeTypes(caps, new Set(DEFAULTS))).toEqual([
      "application/pdf",
      "text/plain",
      "audio/wav",
    ])
  })

  it("classifies a mime by its top-level type", () => {
    expect(mimeModality("image/gif")).toBe("image")
    expect(mimeModality("audio/mpeg")).toBe("audio")
    expect(mimeModality("video/webm")).toBe("video")
    expect(mimeModality("text/csv")).toBe("pdf")
  })
})
