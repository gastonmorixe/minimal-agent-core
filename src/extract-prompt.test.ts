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

  // ---- regression: --resume-same-sid must consume its value -----------
  //
  // Same resume-then-exit footgun as --resume: a value-bearing flag missing
  // from FLAGS_WITH_VALUES leaks its sid as a bare positional, which forces
  // non-interactive mode (run one turn, exit). This is exactly what made a
  // `tmux ... --resume-same-sid <sid>` relaunch run a single turn and die.

  describe("--resume-same-sid must consume its value (resume-in-place stays interactive)", () => {
    test("--resume-same-sid <sid> → none", () => {
      expect(extractPromptFromArgs(["--resume-same-sid", "abc-123-deadbeef"])).toEqual({
        kind: "none",
      })
    })

    test("--resume-same-sid last → none", () => {
      expect(extractPromptFromArgs(["--resume-same-sid", "last"])).toEqual({ kind: "none" })
    })

    test("--resume-same-sid <sid> + bare positional → that positional is the prompt", () => {
      expect(extractPromptFromArgs(["--resume-same-sid", "abc-123", "follow-up question"])).toEqual(
        { kind: "literal", text: "follow-up question" },
      )
    })

    test("normalized subcommand `resume-same <sid>` → none", () => {
      expect(extractPromptFromArgs(normalizeArgs(["resume-same", "abc-123"]))).toEqual({
        kind: "none",
      })
    })

    test("normalized `sessions resume-same <sid>` → none", () => {
      expect(extractPromptFromArgs(normalizeArgs(["sessions", "resume-same", "abc-123"]))).toEqual({
        kind: "none",
      })
    })
  })

  // ---- regression: --mode must consume its value ----------------------

  test("--mode ask + bare positional → positional is the prompt", () => {
    expect(extractPromptFromArgs(["--mode", "ask", "do the thing"])).toEqual({
      kind: "literal",
      text: "do the thing",
    })
  })

  test("--header + bare positional → positional is the prompt", () => {
    expect(extractPromptFromArgs(["--header", "do the thing"])).toEqual({
      kind: "literal",
      text: "do the thing",
    })
  })

  test("--disable-plugin value with bare positional uses the positional prompt", () => {
    expect(extractPromptFromArgs(["--disable-plugin", "web-search", "do the thing"])).toEqual({
      kind: "literal",
      text: "do the thing",
    })
  })

  test("--disable-plugin value alone does not become a prompt", () => {
    expect(extractPromptFromArgs(["--disable-plugin", "web-search"])).toEqual({ kind: "none" })
  })

  // ---- regression: --provider must consume its value ------------------

  test("--provider value with --model value enters interactive REPL", () => {
    expect(
      extractPromptFromArgs(["--model", "vendor/flexible-model:free", "--provider", "gateway"]),
    ).toEqual({ kind: "none" })
  })

  test("--provider=value with --model=value enters interactive REPL after normalization", () => {
    expect(
      extractPromptFromArgs(
        normalizeArgs(["--model=vendor/flexible-model:free", "--provider=gateway"]),
      ),
    ).toEqual({ kind: "none" })
  })

  test("--provider/model flags plus bare positional still use the positional prompt", () => {
    expect(
      extractPromptFromArgs([
        "--provider",
        "gateway",
        "--model",
        "vendor/flexible-model:free",
        "say hi",
      ]),
    ).toEqual({ kind: "literal", text: "say hi" })
  })

  test("--session-id value with --provider and --model enters interactive REPL", () => {
    expect(
      extractPromptFromArgs(
        normalizeArgs([
          "--session-id",
          "sid-123",
          "--model=vendor/flexible-model:free",
          "--provider=gateway",
        ]),
      ),
    ).toEqual({ kind: "none" })
  })

  test("normalized -F does not become a positional prompt", () => {
    expect(
      extractPromptFromArgs(normalizeArgs(["-F", "--model", "model-a", "--provider", "p"])),
    ).toEqual({
      kind: "none",
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
