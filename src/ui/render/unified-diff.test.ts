/**
 * Byte-parity pin for the host UI unified-diff renderer.
 *
 * The expected strings below were captured VERBATIM from the diff-view
 * plugin's `renderUnifiedDiff` (plugins/diff-view/handlers/render.ts)
 * on 2026-06-10, BEFORE `src/diff.ts` / the replay derivers switched to
 * the core-local copy (Wave A unit A-2). They are the characterization
 * contract: the core copy must produce byte-identical output for the
 * same inputs, so the Edit/Write transcript hunks and the replay
 * derivations keep the exact pink/lime/cyan styling users saw before
 * the seam landed.
 *
 * NOTE: this test deliberately does NOT import the plugin (that would
 * add a new I2 core→plugins site). The pinned bytes ARE the plugin's
 * output; regenerate them from the plugin renderer only on a deliberate,
 * reviewed styling change.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { renderUnifiedDiff } from "@minimal-agent/plugin-api/utils/unified-diff"

const PATCH = [
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,4 +1,4 @@",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  " const c = 4",
  "",
  "plain trailing line",
].join("\n")

/** Plugin output for `renderUnifiedDiff(PATCH)` with no palette env. */
const EXPECTED_PLAIN =
  "\u001b[1m--- a/src/example.ts\u001b[0m\n" +
  "\u001b[1m+++ b/src/example.ts\u001b[0m\n" +
  "\u001b[36m@@ -1,4 +1,4 @@\u001b[0m\n" +
  " const a = 1\n" +
  "\u001b[38;5;199m-const b = 2\u001b[0m\n" +
  "\u001b[38;5;118m+const b = 3\u001b[0m\n" +
  " const c = 4\n" +
  "\n" +
  "plain trailing line"

/** Plugin output for `renderUnifiedDiff(PATCH, "New file: /tmp/target.txt")`. */
const EXPECTED_TITLED =
  "\u001b[1mNew file: /tmp/target.txt\u001b[0m\n" +
  "\u001b[2m─────────────────────────────\u001b[0m\n" +
  EXPECTED_PLAIN

/** A title long enough to hit the 64-cell underline cap. */
const LONG_TITLE = "A very long title that should exceed the sixty-four char underline cap for sure"

/** Plugin output for the long-title underline cap (64 dashes exactly). */
const EXPECTED_LONG_TITLE = `\u001b[1m${LONG_TITLE}\u001b[0m\n\u001b[2m${"─".repeat(64)}\u001b[0m\n${EXPECTED_PLAIN}`

/** Plugin output with MINIMAL_AGENT_PALETTE overriding all three tokens. */
const EXPECTED_PALETTED =
  "\u001b[1m--- a/src/example.ts\u001b[0m\n" +
  "\u001b[1m+++ b/src/example.ts\u001b[0m\n" +
  "\u001b[35m@@ -1,4 +1,4 @@\u001b[0m\n" +
  " const a = 1\n" +
  "\u001b[31m-const b = 2\u001b[0m\n" +
  "\u001b[32m+const b = 3\u001b[0m\n" +
  " const c = 4\n" +
  "\n" +
  "plain trailing line"

describe("ui/render/unified-diff — byte parity with the diff-view plugin renderer", () => {
  let savedPalette: string | undefined

  beforeEach(() => {
    savedPalette = process.env.MINIMAL_AGENT_PALETTE
    delete process.env.MINIMAL_AGENT_PALETTE
  })

  afterEach(() => {
    if (savedPalette === undefined) delete process.env.MINIMAL_AGENT_PALETTE
    else process.env.MINIMAL_AGENT_PALETTE = savedPalette
  })

  it("renders a bare patch byte-identically to the plugin (default palette)", () => {
    expect(renderUnifiedDiff(PATCH)).toBe(EXPECTED_PLAIN)
  })

  it("renders a titled patch byte-identically (title + dim underline)", () => {
    expect(renderUnifiedDiff(PATCH, "New file: /tmp/target.txt")).toBe(EXPECTED_TITLED)
  })

  it("caps the title underline at 64 cells, byte-identically", () => {
    expect(renderUnifiedDiff(PATCH, LONG_TITLE)).toBe(EXPECTED_LONG_TITLE)
  })

  it("honors MINIMAL_AGENT_PALETTE tokens byte-identically", () => {
    process.env.MINIMAL_AGENT_PALETTE = JSON.stringify({
      removal: "\u001b[31m",
      addition: "\u001b[32m",
      "accent-soft": "\u001b[35m",
    })
    expect(renderUnifiedDiff(PATCH)).toBe(EXPECTED_PALETTED)
  })

  it("falls back to defaults on malformed palette JSON", () => {
    process.env.MINIMAL_AGENT_PALETTE = "{not json"
    expect(renderUnifiedDiff(PATCH)).toBe(EXPECTED_PLAIN)
  })
})
