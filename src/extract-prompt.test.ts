import { describe, expect, test } from "bun:test"
import { normalizeArgs } from "./cli-args.ts"
import { extractPromptFromArgs, FLAGS_NO_VALUE, FLAGS_WITH_VALUES } from "./extract-prompt.ts"

describe("extractPromptFromArgs", () => {
  test("empty args → none (interactive REPL)", () => {
    expect(extractPromptFromArgs([])).toEqual({ kind: "none" })
  })

  test("--prompt <text> → literal", () => {
    expect(extractPromptFromArgs(["--prompt", "hello"])).toEqual({
      kind: "literal",
      text: "hello",
    })
  })

  test("`-` → stdin", () => {
    expect(extractPromptFromArgs(["-"])).toEqual({ kind: "stdin" })
  })

  test("bare positional → literal", () => {
    expect(extractPromptFromArgs(["follow-up question"])).toEqual({
      kind: "literal",
      text: "follow-up question",
    })
  })

  // ---- regression: --resume must not leak its value as the prompt -------

  describe("--resume must consume its value (regression for resume-then-exit bug)", () => {
    test("--resume last → none", () => {
      expect(extractPromptFromArgs(["--resume", "last"])).toEqual({ kind: "none" })
    })

    test("--resume <sid> → none", () => {
      expect(extractPromptFromArgs(["--resume", "abc-123-deadbeef"])).toEqual({ kind: "none" })
    })

    test("--resume last + bare positional → that positional is the prompt", () => {
      expect(extractPromptFromArgs(["--resume", "last", "follow-up question"])).toEqual({
        kind: "literal",
        text: "follow-up question",
      })
    })

    test("normalized `-r last` → none", () => {
      expect(extractPromptFromArgs(normalizeArgs(["-r", "last"]))).toEqual({
        kind: "none",
      })
    })

    test("normalized subcommand `resume <sid>` → none", () => {
      expect(extractPromptFromArgs(normalizeArgs(["resume", "abc"]))).toEqual({
        kind: "none",
      })
    })

    test("normalized `--resume=last` → none", () => {
      expect(extractPromptFromArgs(normalizeArgs(["--resume=last"]))).toEqual({
        kind: "none",
      })
    })
  })

  // ---- precedence ------------------------------------------------------

  test("--prompt wins over --resume's value", () => {
    expect(extractPromptFromArgs(["--resume", "last", "--prompt", "x"])).toEqual({
      kind: "literal",
      text: "x",
    })
  })

  test("--prompt wins over a bare positional", () => {
    expect(extractPromptFromArgs(["positional", "--prompt", "x"])).toEqual({
      kind: "literal",
      text: "x",
    })
  })

  test("`-` wins over a bare positional (when no --prompt)", () => {
    // The `-` sentinel signals stdin; once present, the positional is
    // ignored. (This matches the prior in-line implementation.)
    expect(extractPromptFromArgs(["-", "positional"])).toEqual({ kind: "stdin" })
  })

  // ---- skipping value-bearing flags -----------------------------------

  test("each value-bearing flag consumes its successor as the value", () => {
    for (const flag of FLAGS_WITH_VALUES) {
      if (flag === "--prompt") continue // already covered as a literal short-circuit
      expect(extractPromptFromArgs([flag, "VAL"])).toEqual({ kind: "none" })
      expect(extractPromptFromArgs([flag, "VAL", "real-prompt"])).toEqual({
        kind: "literal",
        text: "real-prompt",
      })
    }
  })

  test("each no-value flag does not consume the next positional", () => {
    for (const flag of FLAGS_NO_VALUE) {
      if (flag === "-") continue // `-` triggers stdin sentinel, separate path
      expect(extractPromptFromArgs([flag, "real-prompt"])).toEqual({
        kind: "literal",
        text: "real-prompt",
      })
    }
  })

  // ---- the prior bug, end-to-end through normalizeArgs -----------------

  test("end-to-end: every documented resume invocation enters REPL", () => {
    const cases = [
      ["--resume", "last"],
      ["--resume", "abc-123"],
      ["-r", "last"],
      ["resume", "last"],
      ["--resume=last"],
    ]
    for (const raw of cases) {
      const normalized = normalizeArgs(raw)
      const got = extractPromptFromArgs(normalized)
      expect(got).toEqual({ kind: "none" })
    }
  })
})
