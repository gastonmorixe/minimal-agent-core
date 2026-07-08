import { describe, expect, test } from "bun:test"

import {
  applyPromptPartOverride,
  hasSystemPromptOverrides,
  resolveSystemPromptOverrides,
  SystemPromptOverrideError,
} from "./system-prompt-overrides.ts"

describe("resolveSystemPromptOverrides", () => {
  test("empty sources preserve defaults", () => {
    expect(resolveSystemPromptOverrides()).toEqual({})
    expect(hasSystemPromptOverrides(resolveSystemPromptOverrides())).toBe(false)
  })

  test("resolves inline replacement text", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { instructions: { text: "custom instructions" } },
      }),
    ).toEqual({ instructions: { kind: "replace", text: "custom instructions" } })
  })

  test("empty inline replacement text means omit", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { instructions: { text: "" } },
      }),
    ).toEqual({ instructions: { kind: "omit" } })
  })

  test("explicit omit means omit", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { loopSafety: { omit: true } },
      }),
    ).toEqual({ loopSafety: { kind: "omit" } })
  })

  test("file text replacement is already loaded before the pure resolver", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { identity: { fileText: "identity from file" } },
      }),
    ).toEqual({ identity: { kind: "replace", text: "identity from file" } })
  })

  test("empty file text means omit", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { identity: { fileText: "" } },
      }),
    ).toEqual({ identity: { kind: "omit" } })
  })

  test("CLI wins over env and config", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { sessionContext: { text: "cli" } },
        env: { sessionContext: { text: "env" } },
        config: { sessionContext: { text: "config" } },
      }),
    ).toEqual({ sessionContext: { kind: "replace", text: "cli" } })
  })

  test("env wins over config when CLI is absent", () => {
    expect(
      resolveSystemPromptOverrides({
        env: { toolOutputConventions: { omit: true } },
        config: { toolOutputConventions: { text: "config" } },
      }),
    ).toEqual({ toolOutputConventions: { kind: "omit" } })
  })

  test("config is used when CLI and env are absent", () => {
    expect(
      resolveSystemPromptOverrides({
        config: { full: { text: "config full prompt" } },
      }),
    ).toEqual({ full: { kind: "replace", text: "config full prompt" } })
  })

  test("unsafe provider override flag follows the same precedence", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { unsafeProviderOverrides: false },
        env: { unsafeProviderOverrides: true },
        config: { unsafeProviderOverrides: true },
      }),
    ).toEqual({ unsafeProviderOverrides: false })

    expect(
      resolveSystemPromptOverrides({
        env: { unsafeProviderOverrides: true },
        config: { unsafeProviderOverrides: false },
      }),
    ).toEqual({ unsafeProviderOverrides: true })
  })

  test("provider preamble overrides require the unsafe opt-in", () => {
    expect(() =>
      resolveSystemPromptOverrides({
        cli: { providerPreamble: { text: "custom preamble" } },
      }),
    ).toThrow(SystemPromptOverrideError)

    expect(
      resolveSystemPromptOverrides({
        cli: {
          providerPreamble: { text: "custom preamble" },
          unsafeProviderOverrides: true,
        },
      }),
    ).toEqual({
      providerPreamble: { kind: "replace", text: "custom preamble" },
      unsafeProviderOverrides: true,
    })
  })

  test("full prompt overrides ignore individual core part overrides", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: {
          full: { text: "whole prompt" },
          identity: { text: "identity" },
          instructions: { text: "instructions" },
          loopSafety: { omit: true },
          toolOutputConventions: { text: "tool output" },
          sessionContext: { text: "session" },
        },
      }),
    ).toEqual({ full: { kind: "replace", text: "whole prompt" } })
  })

  test("full prompt overrides do not ignore provider preamble overrides", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: {
          full: { text: "whole prompt" },
          providerPreamble: { text: "custom preamble" },
          unsafeProviderOverrides: true,
        },
      }),
    ).toEqual({
      full: { kind: "replace", text: "whole prompt" },
      providerPreamble: { kind: "replace", text: "custom preamble" },
      unsafeProviderOverrides: true,
    })
  })

  test("detects text plus file conflicts in the winning tier", () => {
    expect(() =>
      resolveSystemPromptOverrides({
        cli: { instructions: { text: "x", fileText: "y" } },
      }),
    ).toThrow(SystemPromptOverrideError)
  })

  test("detects text plus omit conflicts in the winning tier", () => {
    expect(() =>
      resolveSystemPromptOverrides({
        cli: { instructions: { text: "x", omit: true } },
      }),
    ).toThrow(SystemPromptOverrideError)
  })

  test("detects file plus omit conflicts in the winning tier", () => {
    expect(() =>
      resolveSystemPromptOverrides({
        cli: { instructions: { fileText: "x", omit: true } },
      }),
    ).toThrow(SystemPromptOverrideError)
  })

  test("lower-precedence conflicts do not matter when a higher tier has a value", () => {
    expect(
      resolveSystemPromptOverrides({
        cli: { instructions: { text: "cli" } },
        env: { instructions: { text: "x", fileText: "y" } },
      }),
    ).toEqual({ instructions: { kind: "replace", text: "cli" } })
  })

  test("collects multiple winning-tier conflicts", () => {
    try {
      resolveSystemPromptOverrides({
        cli: {
          instructions: { text: "x", fileText: "y" },
          identity: { fileText: "x", omit: true },
        },
      })
    } catch (err) {
      expect(err).toBeInstanceOf(SystemPromptOverrideError)
      expect((err as SystemPromptOverrideError).problems).toEqual([
        "cli.identity sets conflicting file + omit overrides",
        "cli.instructions sets conflicting text + file overrides",
      ])
      return
    }
    throw new Error("expected SystemPromptOverrideError")
  })
})

describe("applyPromptPartOverride", () => {
  test("default and undefined keep the original text", () => {
    expect(applyPromptPartOverride("base", undefined)).toBe("base")
    expect(applyPromptPartOverride("base", { kind: "default" })).toBe("base")
  })

  test("replace returns replacement text", () => {
    expect(applyPromptPartOverride("base", { kind: "replace", text: "custom" })).toBe("custom")
  })

  test("omit removes the text", () => {
    expect(applyPromptPartOverride("base", { kind: "omit" })).toBeUndefined()
  })
})

describe("hasSystemPromptOverrides", () => {
  test("detects active part overrides", () => {
    expect(hasSystemPromptOverrides({ instructions: { kind: "replace", text: "x" } })).toBe(true)
    expect(hasSystemPromptOverrides({ instructions: { kind: "omit" } })).toBe(true)
  })

  test("ignores unsafeProviderOverrides because it changes no bytes by itself", () => {
    expect(hasSystemPromptOverrides({ unsafeProviderOverrides: true })).toBe(false)
  })
})
