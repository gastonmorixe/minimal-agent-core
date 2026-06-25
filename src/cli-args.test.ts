import { describe, expect, test } from "bun:test"

import { normalizeArgs } from "./cli-args.ts"

describe("normalizeArgs", () => {
  test("passes through canonical long flags unchanged", () => {
    expect(normalizeArgs(["--model", "claude-opus-4-7", "--debug"])).toEqual([
      "--model",
      "claude-opus-4-7",
      "--debug",
    ])
  })

  test("expands short flags", () => {
    expect(normalizeArgs(["-m", "opus", "-p", "hi"])).toEqual(["--model", "opus", "--prompt", "hi"])
    expect(normalizeArgs(["-d", "-v"])).toEqual(["--debug", "--verbose"])
    expect(normalizeArgs(["-F"])).toEqual(["--fast"])
    expect(normalizeArgs(["-h"])).toEqual(["--help"])
    expect(normalizeArgs(["-r", "last"])).toEqual(["--resume", "last"])
    expect(normalizeArgs(["-f", "cat", "-e", "high", "-s", "dots"])).toEqual([
      "--formatter",
      "cat",
      "--effort",
      "high",
      "--spinner",
      "dots",
    ])
  })

  test("preserves the bare `-` stdin sentinel", () => {
    expect(normalizeArgs(["-"])).toEqual(["-"])
    expect(normalizeArgs(["-m", "opus", "-"])).toEqual(["--model", "opus", "-"])
  })

  test("expands --flag=value form", () => {
    expect(normalizeArgs(["--model=opus", "--effort=high"])).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
    ])
  })

  test("--flag=value resolves long aliases on the key", () => {
    // `--list-sessions=<query>` flows through to `--sessions <query>`,
    // which downstream treats as a fuzzy filter.
    expect(normalizeArgs(["--list-sessions=abc123"])).toEqual(["--sessions", "abc123"])
  })

  test("long aliases for list-* subcommands", () => {
    expect(normalizeArgs(["--models"])).toEqual(["--list-models"])
    expect(normalizeArgs(["--flags"])).toEqual(["--list-flags"])
    expect(normalizeArgs(["--spinners"])).toEqual(["--list-spinners"])
    expect(normalizeArgs(["--plugins"])).toEqual(["--list-plugins"])
    expect(normalizeArgs(["--session"])).toEqual(["--sessions"])
    expect(normalizeArgs(["--list-sessions"])).toEqual(["--sessions"])
  })

  test("subcommand syntax: bare verb at position 0", () => {
    expect(normalizeArgs(["models"])).toEqual(["--list-models"])
    expect(normalizeArgs(["flags"])).toEqual(["--list-flags"])
    expect(normalizeArgs(["spinners"])).toEqual(["--list-spinners"])
    expect(normalizeArgs(["plugins"])).toEqual(["--list-plugins"])
    expect(normalizeArgs(["sessions"])).toEqual(["--sessions"])
    expect(normalizeArgs(["usage"])).toEqual(["--usage"])
    expect(normalizeArgs(["help"])).toEqual(["--help"])
  })

  test("usage subcommand: optional period value + alias", () => {
    expect(normalizeArgs(["usage", "month"])).toEqual(["--usage", "month"])
    expect(normalizeArgs(["usage", "ytd", "--debug"])).toEqual(["--usage", "ytd", "--debug"])
    // No value, next token is a flag → just the bare flag.
    expect(normalizeArgs(["usage", "--debug"])).toEqual(["--usage", "--debug"])
    // --flag=value form via alias.
    expect(normalizeArgs(["--usage=year"])).toEqual(["--usage", "year"])
    expect(normalizeArgs(["--usage-stats"])).toEqual(["--usage"])
  })

  test("subcommand syntax: `<verb> list` sugar", () => {
    expect(normalizeArgs(["models", "list"])).toEqual(["--list-models"])
    expect(normalizeArgs(["flags", "list"])).toEqual(["--list-flags"])
    expect(normalizeArgs(["spinners", "list"])).toEqual(["--list-spinners"])
    expect(normalizeArgs(["plugins", "list"])).toEqual(["--list-plugins"])
    expect(normalizeArgs(["sessions", "list"])).toEqual(["--sessions"])
  })

  test("subcommand syntax: `resume <sid>` consumes the next positional", () => {
    expect(normalizeArgs(["resume", "abc123"])).toEqual(["--resume", "abc123"])
    expect(normalizeArgs(["resume", "last"])).toEqual(["--resume", "last"])
  })

  test("subcommand syntax: `resume-same <sid>` → --resume-same-sid", () => {
    expect(normalizeArgs(["resume-same", "abc123"])).toEqual(["--resume-same-sid", "abc123"])
    expect(normalizeArgs(["resume-same", "last"])).toEqual(["--resume-same-sid", "last"])
    // Missing value → bare flag (parsed later by the --resume-same-sid handler).
    expect(normalizeArgs(["resume-same"])).toEqual(["--resume-same-sid"])
    // Trailing flags.
    expect(normalizeArgs(["resume-same", "abc", "--debug"])).toEqual([
      "--resume-same-sid",
      "abc",
      "--debug",
    ])
  })

  test("`sessions <query>` consumes the next positional as a fuzzy filter", () => {
    expect(normalizeArgs(["sessions", "abc123"])).toEqual(["--sessions", "abc123"])
    expect(normalizeArgs(["sessions", "minimal-agent"])).toEqual(["--sessions", "minimal-agent"])
    // Date fragments are valid queries too.
    expect(normalizeArgs(["sessions", "2026-05"])).toEqual(["--sessions", "2026-05"])
  })

  test("`sessions list` is still the no-filter sugar (not a query)", () => {
    // Already covered by the generic `<verb> list` test, but pin it
    // explicitly because the parser now has a special branch for it.
    expect(normalizeArgs(["sessions", "list"])).toEqual(["--sessions"])
  })

  test("`sessions resume <sid>` mirrors top-level `resume <sid>`", () => {
    expect(normalizeArgs(["sessions", "resume", "abc123"])).toEqual(["--resume", "abc123"])
    expect(normalizeArgs(["sessions", "resume", "last"])).toEqual(["--resume", "last"])
    // Trailing flags are preserved.
    expect(normalizeArgs(["sessions", "resume", "abc", "--debug"])).toEqual([
      "--resume",
      "abc",
      "--debug",
    ])
    // Missing sid → bare `--resume` (parity with `resume` alone).
    expect(normalizeArgs(["sessions", "resume"])).toEqual(["--resume"])
    expect(normalizeArgs(["sessions", "resume", "--debug"])).toEqual(["--resume", "--debug"])
  })

  test("`sessions dump <sid>` mirrors top-level `--dump <sid>`", () => {
    expect(normalizeArgs(["sessions", "dump", "abc123"])).toEqual(["--dump", "abc123"])
    expect(normalizeArgs(["sessions", "dump", "last"])).toEqual(["--dump", "last"])
    // Trailing flags.
    expect(normalizeArgs(["sessions", "dump", "abc", "--debug"])).toEqual([
      "--dump",
      "abc",
      "--debug",
    ])
    // Missing sid → bare `--dump`.
    expect(normalizeArgs(["sessions", "dump"])).toEqual(["--dump"])
    expect(normalizeArgs(["sessions", "dump", "--debug"])).toEqual(["--dump", "--debug"])
    // With --dump-format.
    expect(normalizeArgs(["sessions", "dump", "abc", "--dump-format", "xml"])).toEqual([
      "--dump",
      "abc",
      "--dump-format",
      "xml",
    ])
  })

  test("`sessions resume-same <sid>` → --resume-same-sid", () => {
    expect(normalizeArgs(["sessions", "resume-same", "abc123"])).toEqual([
      "--resume-same-sid",
      "abc123",
    ])
    expect(normalizeArgs(["sessions", "resume-same", "last"])).toEqual([
      "--resume-same-sid",
      "last",
    ])
    // Missing sid.
    expect(normalizeArgs(["sessions", "resume-same"])).toEqual(["--resume-same-sid"])
  })

  test("`sessions` followed by a flag is a bare list, not a query", () => {
    expect(normalizeArgs(["sessions", "--debug"])).toEqual(["--sessions", "--debug"])
  })

  test("`sessions <query>` keeps subsequent flags", () => {
    expect(normalizeArgs(["sessions", "abc", "--debug"])).toEqual(["--sessions", "abc", "--debug"])
  })

  test("subcommand verb followed by extra flags keeps them", () => {
    expect(normalizeArgs(["models", "list", "--debug"])).toEqual(["--list-models", "--debug"])
    expect(normalizeArgs(["resume", "abc", "-d"])).toEqual(["--resume", "abc", "--debug"])
  })

  test("subcommand recognition only fires at position 0", () => {
    // A literal "models" appearing later (e.g. as a value) is left alone.
    expect(normalizeArgs(["--prompt", "models"])).toEqual(["--prompt", "models"])
    // Free-standing positional in a non-leading slot is also not a verb.
    expect(normalizeArgs(["--debug", "models"])).toEqual(["--debug", "models"])
  })

  test("unknown short flags are passed through unchanged", () => {
    // We only normalize the documented short flags. Anything else stays
    // verbatim so downstream parsing can complain or ignore.
    expect(normalizeArgs(["-x"])).toEqual(["-x"])
  })

  test("empty argv stays empty", () => {
    expect(normalizeArgs([])).toEqual([])
  })

  test("auth subcommand sugar maps to long flags", () => {
    expect(normalizeArgs(["login"])).toEqual(["--login"])
    expect(normalizeArgs(["logout"])).toEqual(["--logout"])
    expect(normalizeArgs(["auth-status"])).toEqual(["--auth-status"])
  })

  test("provider login command grammar maps to provider-selected OAuth login", () => {
    expect(normalizeArgs(["provider", "openai", "login"])).toEqual([
      "--login",
      "--provider",
      "openai",
    ])
    expect(normalizeArgs(["providers", "login", "openai"])).toEqual([
      "--login",
      "--provider",
      "openai",
    ])
    expect(normalizeArgs(["login", "openai"])).toEqual(["--login", "--provider", "openai"])
    expect(normalizeArgs(["provider", "openai", "login", "oauth"])).toEqual([
      "--login",
      "--provider",
      "openai",
      "--auth-method",
      "oauth",
    ])
    expect(normalizeArgs(["provider", "openai", "login", "api-key"])).toEqual([
      "--login",
      "--provider",
      "openai",
      "--auth-method",
      "api-key",
    ])
    expect(normalizeArgs(["providers", "login", "openai", "api-key"])).toEqual([
      "--login",
      "--provider",
      "openai",
      "--auth-method",
      "api-key",
    ])
    expect(normalizeArgs(["login", "openai", "oauth"])).toEqual([
      "--login",
      "--provider",
      "openai",
      "--auth-method",
      "oauth",
    ])
  })

  test("provider model command grammar maps to provider-filtered model list", () => {
    expect(normalizeArgs(["provider", "openai", "models"])).toEqual(["--list-models", "openai"])
  })

  test("auth subcommands keep trailing flags after the verb", () => {
    // `minimal-agent login --email foo@bar` → `--login --email foo@bar`.
    // The subcommand recognizer only consumes the first positional;
    // anything that follows is preserved verbatim for the value-flag
    // walker to pick up later.
    expect(normalizeArgs(["login", "--email", "foo@bar"])).toEqual([
      "--login",
      "--email",
      "foo@bar",
    ])
  })
})
