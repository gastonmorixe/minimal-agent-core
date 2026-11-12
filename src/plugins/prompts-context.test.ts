import { describe, expect, it } from "bun:test"

import { CoreError } from "../errors/core-error.ts"

import {
  createPluginPromptsContext,
  PromptTemplateProviderMissingError,
  parsePromptTemplateRaw,
} from "./prompts-context.ts"
import type { PromptRenderRequest, PromptTemplateProvider } from "./types.ts"

describe("createPluginPromptsContext", () => {
  it("render adds only pluginId and pluginDir and forwards name and vars", () => {
    const seen: PromptRenderRequest[] = []
    const provider: PromptTemplateProvider = {
      render: (req) => {
        seen.push(req)
        return "out"
      },
      expand: (t) => `x${t}`,
    }
    const ctx = createPluginPromptsContext(() => provider, "p1", "/d/p1")
    expect(ctx.render("a.md", { k: 1 })).toBe("out")
    expect(ctx.render("b.md")).toBe("out")
    expect(ctx.expand("t")).toBe("xt")
    expect(seen[0]).toEqual({ pluginId: "p1", pluginDir: "/d/p1", name: "a.md", vars: { k: 1 } })
    expect(seen[1]).toEqual({ pluginId: "p1", pluginDir: "/d/p1", name: "b.md" })
  })

  it("throws a typed CoreError with no provider", () => {
    const ctx = createPluginPromptsContext(() => undefined, "p1", "/d")
    for (const call of [() => ctx.render("a"), () => ctx.expand("a")]) {
      try {
        call()
        throw new Error("no throw")
      } catch (e) {
        expect(e).toBeInstanceOf(PromptTemplateProviderMissingError)
        expect(e).toBeInstanceOf(CoreError)
        expect((e as PromptTemplateProviderMissingError).pluginId).toBe("p1")
      }
    }
  })

  it("reads the provider lazily at call time", () => {
    let p: PromptTemplateProvider | undefined
    const ctx = createPluginPromptsContext(() => p, "p1", "/d")
    expect(() => ctx.expand("a")).toThrow()
    p = { render: () => "", expand: (t) => t }
    expect(ctx.expand("a")).toBe("a")
  })
})

describe("parsePromptTemplateRaw (raw manifest key)", () => {
  it("accepts {id, entry}", () => {
    expect(parsePromptTemplateRaw({ id: "v1", entry: "./p.ts", extra: 1 })).toEqual({
      id: "v1",
      entry: "./p.ts",
    })
  })
  it("rejects bad shapes", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { id: "", entry: "a" },
      { id: "a", entry: "" },
      { id: "a", entry: 3 },
    ]) {
      expect(parsePromptTemplateRaw(bad)).toBeUndefined()
    }
  })
})
