import { describe, expect, test } from "bun:test"

import { findDashTypos, formatDashTypoError, normalizeArgs } from "./cli-args.ts"

describe("normalizeArgs", () => {
  test("passes through canonical long flags unchanged", () => {
    expect(normalizeArgs(["--model", "test-model-1", "--debug"])).toEqual([
      "--model",
      "test-model-1",
      "--debug",
    ])
  })

  test("expands short flags", () => {
    expect(normalizeArgs(["-m", "premium", "-p", "hi"])).toEqual([
      "--model",
      "premium",
      "--prompt",
      "hi",
    ])
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
    expect(normalizeArgs(["-m", "premium", "-"])).toEqual(["--model", "premium", "-"])
  })

  test("expands --flag=value form", () => {
    expect(normalizeArgs(["--model=premium", "--effort=high"])).toEqual([
      "--model",
      "premium",
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
    expect(normalizeArgs(["provider", "acme", "login"])).toEqual(["--login", "--provider", "acme"])
    expect(normalizeArgs(["providers", "login", "acme"])).toEqual(["--login", "--provider", "acme"])
    expect(normalizeArgs(["login", "acme"])).toEqual(["--login", "--provider", "acme"])
    expect(normalizeArgs(["provider", "acme", "login", "oauth"])).toEqual([
      "--login",
      "--provider",
      "acme",
      "--auth-method",
      "oauth",
    ])
    expect(normalizeArgs(["provider", "acme", "login", "api-key"])).toEqual([
      "--login",
      "--provider",
      "acme",
      "--auth-method",
      "api-key",
    ])
    expect(normalizeArgs(["providers", "login", "acme", "api-key"])).toEqual([
      "--login",
      "--provider",
      "acme",
      "--auth-method",
      "api-key",
    ])
    expect(normalizeArgs(["login", "acme", "oauth"])).toEqual([
      "--login",
      "--provider",
      "acme",
      "--auth-method",
      "oauth",
    ])
  })

  test("provider model command grammar maps to provider-filtered model list", () => {
    expect(normalizeArgs(["provider", "acme", "models"])).toEqual(["--list-models", "acme"])
  })

  test("models-live grammar maps to --list-models-live", () => {
    expect(normalizeArgs(["models-live"])).toEqual(["--list-models-live"])
    expect(normalizeArgs(["--models-live"])).toEqual(["--list-models-live"])
    expect(normalizeArgs(["providers", "models-live"])).toEqual(["--list-models-live"])
    expect(normalizeArgs(["providers", "models-live", "acme"])).toEqual([
      "--list-models-live",
      "acme",
    ])
    expect(normalizeArgs(["provider", "acme", "models-live"])).toEqual([
      "--list-models-live",
      "acme",
    ])
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

describe("findDashTypos", () => {
  test("flags a long flag with an en-dash (the reported bug)", () => {
    const typos = findDashTypos(["--resume\u2013same-sid", "abc123"])
    expect(typos).toHaveLength(1)
    expect(typos[0]).toMatchObject({
      arg: "--resume\u2013same-sid",
      index: 0,
      suggestion: "--resume-same-sid",
      codepoint: "U+2013",
    })
  })

  test("rewrites every unicode dash in the suggestion", () => {
    // em-dash prefix + en-dash inside → all become ASCII hyphens.
    const typos = findDashTypos(["\u2014\u2014resume\u2013same\u2013sid"])
    expect(typos[0].suggestion).toBe("--resume-same-sid")
  })

  test("recognizes the full family of dash lookalikes", () => {
    for (const dash of [
      "\u2010",
      "\u2011",
      "\u2012",
      "\u2013",
      "\u2014",
      "\u2015",
      "\u2212",
      "\uFE58",
      "\uFE63",
      "\uFF0D",
    ]) {
      expect(findDashTypos([`-${dash}model`])).toHaveLength(1)
    }
  })

  test("leaves clean ASCII flags alone", () => {
    expect(findDashTypos(["--resume-same-sid", "abc", "--model", "test-model-1"])).toEqual([])
    expect(findDashTypos(["-m", "test-model-1", "--fast"])).toEqual([])
  })

  test("does not flag non-flag positionals containing a dash", () => {
    // A prompt value that happens to contain an en-dash is not a flag
    // (doesn't start with a dash), so it's left untouched.
    expect(findDashTypos(["--prompt", "cost\u2013benefit analysis"])).toEqual([])
    expect(findDashTypos(["a\u2013b"])).toEqual([])
  })

  test("ignores the bare '-' stdin sentinel and empty tokens", () => {
    expect(findDashTypos(["-"])).toEqual([])
    expect(findDashTypos([""])).toEqual([])
  })

  test("reports multiple mangled flags in order", () => {
    const typos = findDashTypos(["\u2013\u2013model", "x", "\u2014\u2014fast"])
    expect(typos.map((t) => t.index)).toEqual([0, 2])
    expect(typos.map((t) => t.suggestion)).toEqual(["--model", "--fast"])
  })
})

describe("formatDashTypoError", () => {
  test("names the codepoint and suggests the ASCII fix", () => {
    const msg = formatDashTypoError(findDashTypos(["--resume\u2013same-sid"]))
    expect(msg).toContain("U+2013")
    expect(msg).toContain("--resume-same-sid")
    expect(msg).toContain("did you mean")
  })

  test("pluralizes the header for multiple typos", () => {
    const msg = formatDashTypoError(findDashTypos(["\u2013\u2013a", "\u2013\u2013b"]))
    expect(msg).toContain("2 arguments contain")
  })
})
