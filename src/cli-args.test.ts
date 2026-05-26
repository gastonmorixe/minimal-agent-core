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
    // `--models=foo` would be nonsense (it's a list flag), but the key
    // alias should still resolve so users get a useful error rather than
    // a silent typo.
    expect(normalizeArgs(["--list-sessions=ignored"])).toEqual(["--sessions", "ignored"])
  })

  test("long aliases for list-* subcommands", () => {
    expect(normalizeArgs(["--models"])).toEqual(["--list-models"])
    expect(normalizeArgs(["--flags"])).toEqual(["--list-flags"])
    expect(normalizeArgs(["--spinners"])).toEqual(["--list-spinners"])
    expect(normalizeArgs(["--session"])).toEqual(["--sessions"])
    expect(normalizeArgs(["--list-sessions"])).toEqual(["--sessions"])
  })

  test("subcommand syntax: bare verb at position 0", () => {
    expect(normalizeArgs(["models"])).toEqual(["--list-models"])
    expect(normalizeArgs(["flags"])).toEqual(["--list-flags"])
    expect(normalizeArgs(["spinners"])).toEqual(["--list-spinners"])
    expect(normalizeArgs(["sessions"])).toEqual(["--sessions"])
    expect(normalizeArgs(["help"])).toEqual(["--help"])
  })

  test("subcommand syntax: `<verb> list` sugar", () => {
    expect(normalizeArgs(["models", "list"])).toEqual(["--list-models"])
    expect(normalizeArgs(["flags", "list"])).toEqual(["--list-flags"])
    expect(normalizeArgs(["spinners", "list"])).toEqual(["--list-spinners"])
    expect(normalizeArgs(["sessions", "list"])).toEqual(["--sessions"])
  })

  test("subcommand syntax: `resume <sid>` consumes the next positional", () => {
    expect(normalizeArgs(["resume", "abc123"])).toEqual(["--resume", "abc123"])
    expect(normalizeArgs(["resume", "last"])).toEqual(["--resume", "last"])
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
