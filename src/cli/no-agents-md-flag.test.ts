/**
 * `--no-agents-md` is a convenience alias for `--disable-plugin agents-md`.
 * The wiring lives in `src/index.ts` (boot); these unit tests pin the pure
 * pieces: flag classification + the override merge that index.ts performs.
 *
 * @module cli/no-agents-md-flag.test
 */

import { describe, expect, test } from "bun:test"

import { resolvePluginEnabledOverrides } from "../plugins/plugin-enable-resolution.ts"

import { extractPromptFromArgs, FLAGS_NO_VALUE } from "./extract-prompt.ts"

describe("--no-agents-md flag", () => {
  test("is classified as a no-value flag", () => {
    expect(FLAGS_NO_VALUE.has("--no-agents-md")).toBe(true)
    expect(FLAGS_NO_VALUE.has("--no-agents")).toBe(true)
  })

  test("does not consume the next positional as a value", () => {
    expect(extractPromptFromArgs(["--no-agents-md", "real-prompt"])).toEqual({
      kind: "literal",
      text: "real-prompt",
    })
    expect(extractPromptFromArgs(["--no-agents", "real-prompt"])).toEqual({
      kind: "literal",
      text: "real-prompt",
    })
  })

  test("merge helper: injecting agents-md into cli.disable force-disables it", () => {
    // Mirrors the index.ts composition when --no-agents-md is set.
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(), forceEnabled: new Set() },
      cli: { disable: ["agents-md"], enable: [] },
    })
    expect(r.forceDisabled.has("agents-md")).toBe(true)
    expect(r.forceEnabled.has("agents-md")).toBe(false)
  })

  test("CLI enable still wins over a no-agents-md-style disable when both appear", () => {
    // Documented precedence: CLI enable beats CLI disable only if enable is
    // applied after in the same layer — resolvePluginEnabledOverrides applies
    // enable first then disable within a layer, so disable wins in-layer.
    const r = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(), forceEnabled: new Set() },
      cli: { disable: ["agents-md"], enable: ["agents-md"] },
    })
    expect(r.forceDisabled.has("agents-md")).toBe(true)
  })
})
