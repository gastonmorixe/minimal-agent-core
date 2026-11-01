/**
 * Unit tests for {@link splitManifest} (S31): a split manifest passes
 * through, a legacy flat manifest is split, and legacy UI fields give one
 * notice per plugin.
 */

import { describe, expect, it } from "bun:test"

import { splitManifest } from "./manifest-legacy.ts"

describe("splitManifest", () => {
  it("passes a split manifest through", () => {
    const headless = { tools: [{ id: "a" }] }
    const ui = { liveAreaSlots: [] }
    const split = splitManifest({ id: "p", headless, ui })
    expect(split.headless).toBe(headless)
    expect(split.ui).toBe(ui)
    expect(split.mixedKeys).toEqual([])
    expect(split.legacyNotice).toBeUndefined()
  })

  it("splits a flat manifest: tuis become headless.tools, liveAreaSlots go to ui", () => {
    const split = splitManifest({
      id: "p",
      tuis: [{ id: "a" }],
      hooks: [{ id: "h" }],
      setup: { type: "module" },
      liveAreaSlots: [{ id: "s" }],
    })
    expect(split.headless).toEqual({
      tools: [{ id: "a" }],
      hooks: [{ id: "h" }],
      setup: { type: "module" },
    })
    expect(split.ui).toEqual({ liveAreaSlots: [{ id: "s" }] })
  })

  it("gives no notice for a flat manifest with no UI fields", () => {
    expect(splitManifest({ id: "p", tuis: [{ id: "a" }], hooks: [] }).legacyNotice).toBeUndefined()
  })

  it("gives one notice for icon/color/headerKey, in either form", () => {
    const flat = splitManifest({
      id: "my-plugin",
      tuis: [{ id: "a", icon: "»" }, { color: "sky" }],
    })
    expect(flat.legacyNotice).toContain('plugin "my-plugin"')
    expect(flat.legacyNotice).toContain("icon/color/headerKey")
    expect(flat.legacyNotice).toContain("icon, color")
    const split = splitManifest({ id: "q", headless: { tools: [{ id: "a", headerKey: "url" }] } })
    expect(split.legacyNotice).toContain("headerKey")
  })

  it("gives one notice for a flat liveAreaSlots array", () => {
    expect(splitManifest({ id: "p", liveAreaSlots: [] }).legacyNotice).toContain(
      "flat liveAreaSlots",
    )
  })

  it("lists flat contribution keys next to a headless block", () => {
    expect(splitManifest({ id: "p", headless: {}, tuis: [], modes: [] }).mixedKeys).toEqual([
      "modes",
      "tuis",
    ])
  })
})
