import { describe, expect, test } from "bun:test"

import {
  isPluginPromptSuppressed,
  NO_PLUGIN_PROMPT_SUPPRESSION,
  resolvePluginPromptSuppression,
} from "./plugin-prompt-resolution.ts"

describe("isPluginPromptSuppressed", () => {
  test("default suppresses nothing", () => {
    expect(isPluginPromptSuppressed(NO_PLUGIN_PROMPT_SUPPRESSION, "skills")).toBe(false)
  })

  test("the shared default cannot be mutated by a caller", () => {
    // A leaked mutation here would corrupt every other consumer of the const.
    expect(() => {
      // The type forbids these calls, which is the point of the check.
      ;(NO_PLUGIN_PROMPT_SUPPRESSION.suppress as Set<string>).add("skills")
    }).toThrow()
    expect(() => {
      ;(NO_PLUGIN_PROMPT_SUPPRESSION.keep as Set<string>).add("skills")
    }).toThrow()
    // A second read sees the same clean default.
    expect(NO_PLUGIN_PROMPT_SUPPRESSION.suppress.size).toBe(0)
    expect(NO_PLUGIN_PROMPT_SUPPRESSION.keep.size).toBe(0)
    expect(isPluginPromptSuppressed(NO_PLUGIN_PROMPT_SUPPRESSION, "skills")).toBe(false)
    expect(Object.isFrozen(NO_PLUGIN_PROMPT_SUPPRESSION)).toBe(true)
  })

  test("all=true suppresses an unlisted id", () => {
    const s = { all: true, suppress: new Set<string>(), keep: new Set<string>() }
    expect(isPluginPromptSuppressed(s, "skills")).toBe(true)
  })

  test("keep wins over all=true", () => {
    const s = { all: true, suppress: new Set<string>(), keep: new Set(["memory"]) }
    expect(isPluginPromptSuppressed(s, "memory")).toBe(false)
  })

  test("suppress wins over all=false", () => {
    const s = { all: false, suppress: new Set(["skills"]), keep: new Set<string>() }
    expect(isPluginPromptSuppressed(s, "skills")).toBe(true)
  })

  test("keep wins over suppress for the same id", () => {
    const s = { all: false, suppress: new Set(["skills"]), keep: new Set(["skills"]) }
    expect(isPluginPromptSuppressed(s, "skills")).toBe(false)
  })
})

describe("resolvePluginPromptSuppression precedence", () => {
  test("default is nothing suppressed", () => {
    const { suppression, warnings } = resolvePluginPromptSuppression({})
    expect(suppression.all).toBe(false)
    expect(suppression.keep.size).toBe(0)
    expect(suppression.suppress.size).toBe(0)
    expect(warnings).toEqual([])
  })

  test("cli all=false beats env all=true", () => {
    const { suppression } = resolvePluginPromptSuppression({
      env: "1",
      cli: { all: false },
    })
    expect(suppression.all).toBe(false)
  })

  test("env all=false beats config all=true", () => {
    const { suppression } = resolvePluginPromptSuppression({
      config: true,
      env: "false",
    })
    expect(suppression.all).toBe(false)
  })

  test("cli keep beats env suppress for the same id", () => {
    const { suppression } = resolvePluginPromptSuppression({
      env: "1",
      cli: { keep: ["memory"] },
    })
    expect(isPluginPromptSuppressed(suppression, "memory")).toBe(false)
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
  })

  test("cli suppress beats config keep for the same id", () => {
    const { suppression } = resolvePluginPromptSuppression({
      config: { keep: ["skills"] },
      cli: { suppress: ["skills"] },
    })
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
  })

  test("config object lists apply", () => {
    const { suppression } = resolvePluginPromptSuppression({
      config: { keep: ["memory"], suppress: ["skills"] },
    })
    expect(suppression.all).toBe(false)
    expect(isPluginPromptSuppressed(suppression, "memory")).toBe(false)
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
    expect(isPluginPromptSuppressed(suppression, "other")).toBe(false)
  })

  test("config false means nothing suppressed, true means all", () => {
    expect(resolvePluginPromptSuppression({ config: false }).suppression.all).toBe(false)
    expect(resolvePluginPromptSuppression({ config: true }).suppression.all).toBe(true)
  })

  test("a bad env value warns and falls through to config", () => {
    const { suppression, warnings } = resolvePluginPromptSuppression({
      config: { suppress: ["skills"] },
      env: "maybe",
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("maybe")
    expect(warnings[0]).toContain("MINIMAL_AGENT_PLUGIN_PROMPTS")
    expect(suppression.all).toBe(false)
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
  })

  test("comma-separated cli ids are split and trimmed", () => {
    const { suppression } = resolvePluginPromptSuppression({
      cli: { suppress: ["skills, memory"] },
    })
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
    expect(isPluginPromptSuppressed(suppression, "memory")).toBe(true)
  })

  test("env all=true keeps the config lists in effect", () => {
    const { suppression } = resolvePluginPromptSuppression({
      config: { keep: ["memory"], suppress: ["skills"] },
      env: "true",
    })
    expect(suppression.all).toBe(true)
    // An `all` from a higher tier only overrides `all`. `keep` still wins
    // for its id (that is what isPluginPromptSuppressed encodes), and the
    // config suppress list agrees with `all`.
    expect(isPluginPromptSuppressed(suppression, "memory")).toBe(false)
    expect(isPluginPromptSuppressed(suppression, "skills")).toBe(true)
  })
})
