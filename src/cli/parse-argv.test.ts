/**
 * Tests for {@link parseCliOptions} — specifically the `--tools` / `--no-tools`
 * flag parsing.
 *
 * @module cli/parse-argv.test
 */

import { describe, expect, test } from "bun:test"

import { type CliToolFilter, parseCliOptions } from "./parse-argv.ts"

const NO_ENV = {} as const
const NO_CFG = {} as const
const NOOP_FORMATTER = (_raw: string): string[] => []

describe("parseCliOptions — cliToolFilter", () => {
  test("no --tools or --no-tools → null filter", () => {
    const opts = parseCliOptions([], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toBeNull()
  })

  test("--no-tools → deny-all filter", () => {
    const opts = parseCliOptions(["--no-tools"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "deny-all" })
  })

  test("--no-tools with other flags still works", () => {
    const opts = parseCliOptions(
      ["--no-tools", "--model", "test-model", "--prompt", "hi"],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "deny-all" })
  })

  test("--tools with single tool → allow-list with one entry", () => {
    const opts = parseCliOptions(["--tools", "Task"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "allow-list", tools: ["Task"] })
  })

  test("--tools with multiple comma-separated tools → allow-list", () => {
    const opts = parseCliOptions(["--tools", "Read,Task,Grep"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({
      kind: "allow-list",
      tools: ["Read", "Task", "Grep"],
    })
  })

  test("--tools with spaces after commas → trimmed", () => {
    const opts = parseCliOptions(["--tools", "Read, Task, Grep"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({
      kind: "allow-list",
      tools: ["Read", "Task", "Grep"],
    })
  })

  test("--tools with empty string → null filter (no tools parsed)", () => {
    const opts = parseCliOptions(["--tools", ""], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toBeNull()
  })

  test("--tools with only commas → null filter", () => {
    const opts = parseCliOptions(["--tools", ",,,"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toBeNull()
  })

  test("--tools=value form works", () => {
    const opts = parseCliOptions(["--tools=Read,Task"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({
      kind: "allow-list",
      tools: ["Read", "Task"],
    })
  })

  test("--no-tools beats --tools if both appear", () => {
    const opts = parseCliOptions(["--no-tools", "--tools", "Read"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    // --no-tools is checked first in the code
    expect(opts.cliToolFilter).toEqual<CliToolFilter>({ kind: "deny-all" })
  })
})

describe("parseCliOptions — generic endpoint flags", () => {
  test("reads endpoint/format/auth flags from CLI", () => {
    const opts = parseCliOptions(
      [
        "--endpoint",
        "http://localhost:1234/v1/chat/completions",
        "--format",
        "chat-surface",
        "--auth-type",
        "bearer",
        "--api-key",
        "sk-local",
        "--auth-header",
        "X-Api-Key",
        "--provider-model",
        "qwen2.5",
      ],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.endpoint).toBe("http://localhost:1234/v1/chat/completions")
    expect(opts.format).toBe("chat-surface")
    expect(opts.authType).toBe("bearer")
    expect(opts.apiKey).toBe("sk-local")
    expect(opts.authHeader).toBe("X-Api-Key")
    expect(opts.providerModel).toBe("qwen2.5")
  })

  test("--surface is an alias for --format", () => {
    const opts = parseCliOptions(["--surface", "chat-surface"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.format).toBe("chat-surface")
  })

  test("CLI wins over env over config", () => {
    const env = {
      MINIMAL_AGENT_ENDPOINT: "http://env/v1/chat/completions",
      MINIMAL_AGENT_FORMAT: "env-format",
    }
    const cfg = { endpoint: "http://config/v1", format: "config-format" } as const
    const opts = parseCliOptions(["--endpoint", "http://cli/v1"], cfg, env, NOOP_FORMATTER)
    expect(opts.endpoint).toBe("http://cli/v1")
    // format not on CLI → env wins over config
    expect(opts.format).toBe("env-format")
  })

  test("invalid --auth-type is dropped to undefined", () => {
    const opts = parseCliOptions(["--auth-type", "bogus"], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.authType).toBeUndefined()
  })

  test("--effort-levels parses a comma-separated ladder", () => {
    const opts = parseCliOptions(
      ["--effort-levels", "low,medium,high"],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.effortLevels).toEqual(["low", "medium", "high"])
  })

  test("--effort-levels trims whitespace and drops empties", () => {
    const opts = parseCliOptions(
      ["--effort-levels", " low , , high "],
      NO_CFG,
      NO_ENV,
      NOOP_FORMATTER,
    )
    expect(opts.effortLevels).toEqual(["low", "high"])
  })

  test("effort-levels: env used when CLI absent, config when both absent", () => {
    const fromEnv = parseCliOptions(
      [],
      NO_CFG,
      { MINIMAL_AGENT_EFFORT_LEVELS: "a,b" },
      NOOP_FORMATTER,
    )
    expect(fromEnv.effortLevels).toEqual(["a", "b"])
    const fromCfg = parseCliOptions([], { effortLevels: ["x"] }, NO_ENV, NOOP_FORMATTER)
    expect(fromCfg.effortLevels).toEqual(["x"])
  })

  test("no --effort-levels → undefined", () => {
    const opts = parseCliOptions([], NO_CFG, NO_ENV, NOOP_FORMATTER)
    expect(opts.effortLevels).toBeUndefined()
  })
})
