/**
 * Unit tests for {@link MediaResolverAdapter}: wraps `resolveUserTurnContent`.
 * A text-only prompt (no attachment tokens) passes straight through as a
 * single text block, which is the parity-relevant path for the headless
 * `--json` runner.
 */

import { describe, expect, it } from "bun:test"

import { MediaResolverAdapter } from "./media-resolver-adapter.ts"

describe("MediaResolverAdapter", () => {
  it("resolves a text-only prompt to a single text block", async () => {
    const adapter = new MediaResolverAdapter("test-model")
    const blocks = await adapter.resolveUserContent("just some plain text")
    expect(blocks).toEqual([{ type: "text", text: "just some plain text" }])
  })

  it("preserves an empty-ish prompt as text", async () => {
    const adapter = new MediaResolverAdapter("test-model")
    const blocks = await adapter.resolveUserContent("hello world")
    // Exactly one text block, content preserved byte-for-byte.
    expect(blocks.length).toBe(1)
    const first = blocks[0]
    expect(first?.type).toBe("text")
    if (first?.type === "text") expect(first.text).toBe("hello world")
  })
})
