/**
 * Smoke test: the media cluster of `./host/*` subpaths resolves and works
 * through the package name.
 *
 * @module host-public/media.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { clipboardText, hasClipboardImage } from "@minimal-agent/core/host/clipboard"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { mediaPasteInterceptor } from "@minimal-agent/core/host/paste-intercept"

describe("./host/* media cluster (public subpaths)", () => {
  it("./host/clipboard: resolves without throwing on a headless runner", () => {
    expect(typeof hasClipboardImage()).toBe("boolean")
    // clipboardText may be null (no backend / empty clipboard); just must not throw.
    const text = clipboardText()
    expect(text === null || typeof text === "string").toBe(true)
  })

  it("./host/paste-intercept: falls through to literal paste for ordinary text", () => {
    expect(mediaPasteInterceptor("just some typed text")).toBeNull()
  })
})
