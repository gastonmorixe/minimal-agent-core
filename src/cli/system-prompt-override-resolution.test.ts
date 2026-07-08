import { describe, expect, test } from "bun:test"

import { SystemPromptOverrideError } from "../llm/system-prompt-overrides.ts"

import { resolveSystemPromptOverridesForStartup } from "./system-prompt-override-resolution.ts"

function emptyConfig() {
  return {}
}

function fakeReader(map: Record<string, string>) {
  return (path: string): string => {
    const content = map[path]
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }
}

describe("resolveSystemPromptOverridesForStartup", () => {
  test("no overrides returns empty struct", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({})
  })

  // ---- CLI flags -----------------------------------------------------------

  test("CLI --system-instructions replaces instructions", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions", "custom"],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({ instructions: { kind: "replace", text: "custom" } })
  })

  test("CLI --no-system-instructions omits instructions", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--no-system-instructions"],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({ instructions: { kind: "omit" } })
  })

  test("CLI --system-instructions '' omits instructions", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions", ""],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({ instructions: { kind: "omit" } })
  })

  test("CLI --system-instructions-file reads from injected reader", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions-file", "/tmp/inst.md"],
        env: {},
        config: emptyConfig(),
        readFile: fakeReader({ "/tmp/inst.md": "file content" }),
      }),
    ).toEqual({ instructions: { kind: "replace", text: "file content" } })
  })

  test("CLI --system-instructions-file with missing file throws", () => {
    expect(() =>
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions-file", "/tmp/missing.md"],
        env: {},
        config: emptyConfig(),
        readFile: fakeReader({}),
      }),
    ).toThrow(SystemPromptOverrideError)
  })

  test("CLI --system-instructions-file with empty path throws", () => {
    expect(() =>
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions-file", ""],
        env: {},
        config: emptyConfig(),
      }),
    ).toThrow(SystemPromptOverrideError)
  })

  test("CLI --unsafe-system-prompt-overrides propagates", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--unsafe-system-prompt-overrides"],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({ unsafeProviderOverrides: true })
  })

  // ---- Env vars ------------------------------------------------------------

  test("env MINIMAL_AGENT_SYSTEM_INSTRUCTIONS replaces instructions", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: { MINIMAL_AGENT_SYSTEM_INSTRUCTIONS: "env instructions" },
        config: emptyConfig(),
      }),
    ).toEqual({ instructions: { kind: "replace", text: "env instructions" } })
  })

  test("env MINIMAL_AGENT_SYSTEM_INSTRUCTIONS_FILE reads from injected reader", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: { MINIMAL_AGENT_SYSTEM_INSTRUCTIONS_FILE: "/tmp/env.md" },
        config: emptyConfig(),
        readFile: fakeReader({ "/tmp/env.md": "env file" }),
      }),
    ).toEqual({ instructions: { kind: "replace", text: "env file" } })
  })

  test("env MINIMAL_AGENT_UNSAFE_SYSTEM_PROMPT_OVERRIDES=1 propagates", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: { MINIMAL_AGENT_UNSAFE_SYSTEM_PROMPT_OVERRIDES: "1" },
        config: emptyConfig(),
      }),
    ).toEqual({ unsafeProviderOverrides: true })
  })

  test("env MINIMAL_AGENT_UNSAFE_SYSTEM_PROMPT_OVERRIDES=0 is false", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: { MINIMAL_AGENT_UNSAFE_SYSTEM_PROMPT_OVERRIDES: "0" },
        config: emptyConfig(),
      }),
    ).toEqual({ unsafeProviderOverrides: false })
  })

  // ---- Config ---------------------------------------------------------------

  test("config systemPrompt.instructions replaces instructions", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: {},
        config: { systemPrompt: { instructions: "config instructions" } },
      }),
    ).toEqual({ instructions: { kind: "replace", text: "config instructions" } })
  })

  test("config systemPrompt.instructions false omits instructions", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: {},
        config: { systemPrompt: { instructions: false } },
      }),
    ).toEqual({ instructions: { kind: "omit" } })
  })

  test("config systemPrompt.instructions null omits instructions", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: {},
        config: { systemPrompt: { instructions: null } },
      }),
    ).toEqual({ instructions: { kind: "omit" } })
  })

  test("config systemPrompt.instructionsFile reads from injected reader", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: {},
        config: { systemPrompt: { instructionsFile: "/tmp/cfg.md" } },
        readFile: fakeReader({ "/tmp/cfg.md": "config file" }),
      }),
    ).toEqual({ instructions: { kind: "replace", text: "config file" } })
  })

  test("config systemPrompt.unsafeProviderOverrides propagates", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: {},
        config: { systemPrompt: { unsafeProviderOverrides: true } },
      }),
    ).toEqual({ unsafeProviderOverrides: true })
  })

  // ---- Precedence ----------------------------------------------------------

  test("CLI wins over env and config", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions", "cli"],
        env: { MINIMAL_AGENT_SYSTEM_INSTRUCTIONS: "env" },
        config: { systemPrompt: { instructions: "config" } },
      }),
    ).toEqual({ instructions: { kind: "replace", text: "cli" } })
  })

  test("env wins over config when CLI is absent", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: { MINIMAL_AGENT_SYSTEM_INSTRUCTIONS: "env" },
        config: { systemPrompt: { instructions: "config" } },
      }),
    ).toEqual({ instructions: { kind: "replace", text: "env" } })
  })

  test("config is used when CLI and env are absent", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [],
        env: {},
        config: { systemPrompt: { instructions: "config" } },
      }),
    ).toEqual({ instructions: { kind: "replace", text: "config" } })
  })

  // ---- Skip-parts: higher tier blocks lower tier for same part -------------

  test("CLI blocks env and config for the same part", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions", "cli"],
        env: { MINIMAL_AGENT_SYSTEM_INSTRUCTIONS: "env" },
        config: { systemPrompt: { instructions: "config" } },
      }),
    ).toEqual({ instructions: { kind: "replace", text: "cli" } })
  })

  test("CLI on one part does not block env on a different part", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--system-instructions", "cli"],
        env: { MINIMAL_AGENT_SYSTEM_IDENTITY: "env identity" },
        config: {},
      }),
    ).toEqual({
      instructions: { kind: "replace", text: "cli" },
      identity: { kind: "replace", text: "env identity" },
    })
  })

  // ---- Multiple parts ------------------------------------------------------

  test("multiple CLI flags resolve together", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [
          "--system-instructions",
          "custom",
          "--no-system-loop-safety",
          "--system-identity",
          "My Agent",
        ],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({
      instructions: { kind: "replace", text: "custom" },
      loopSafety: { kind: "omit" },
      identity: { kind: "replace", text: "My Agent" },
    })
  })

  // ---- Provider preamble safety --------------------------------------------

  test("provider preamble override without unsafe flag throws", () => {
    expect(() =>
      resolveSystemPromptOverridesForStartup({
        args: ["--provider-system-preamble", "custom"],
        env: {},
        config: emptyConfig(),
      }),
    ).toThrow(SystemPromptOverrideError)
  })

  test("provider preamble override with unsafe flag succeeds", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: ["--provider-system-preamble", "custom", "--unsafe-system-prompt-overrides"],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({
      providerPreamble: { kind: "replace", text: "custom" },
      unsafeProviderOverrides: true,
    })
  })

  // ---- full overrides ignore individual parts ------------------------------

  test("full override ignores individual core parts", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [
          "--system-prompt",
          "whole",
          "--system-instructions",
          "ignored",
          "--no-system-identity",
        ],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({ full: { kind: "replace", text: "whole" } })
  })

  test("full override does not ignore provider preamble", () => {
    expect(
      resolveSystemPromptOverridesForStartup({
        args: [
          "--system-prompt",
          "whole",
          "--provider-system-preamble",
          "preamble",
          "--unsafe-system-prompt-overrides",
        ],
        env: {},
        config: emptyConfig(),
      }),
    ).toEqual({
      full: { kind: "replace", text: "whole" },
      providerPreamble: { kind: "replace", text: "preamble" },
      unsafeProviderOverrides: true,
    })
  })
})
