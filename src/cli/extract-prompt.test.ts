import { describe, expect, test } from "bun:test"

import { normalizeArgs } from "./cli-args.ts"
import { extractPromptFromArgs, FLAGS_NO_VALUE, FLAGS_WITH_VALUES } from "./extract-prompt.ts"
import {
  SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS,
  SYSTEM_PROMPT_OVERRIDE_NO_VALUE_FLAGS,
  SYSTEM_PROMPT_OVERRIDE_VALUE_FLAGS,
} from "./system-prompt-override-flags.ts"

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

  test("all system-prompt override value flags are tracked as value-bearing", () => {
    for (const flag of SYSTEM_PROMPT_OVERRIDE_VALUE_FLAGS) {
      expect(FLAGS_WITH_VALUES.has(flag)).toBe(true)
      expect(extractPromptFromArgs([flag, "VAL"])).toEqual({ kind: "none" })
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

  test("all system-prompt override no-value flags are tracked as no-value flags", () => {
    for (const flag of SYSTEM_PROMPT_OVERRIDE_NO_VALUE_FLAGS) {
      expect(FLAGS_NO_VALUE.has(flag)).toBe(true)
    }
  })

  test("each system-prompt override part has value, file, and no-value flags", () => {
    for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
      expect(FLAGS_WITH_VALUES.has(spec.valueFlag)).toBe(true)
      expect(FLAGS_WITH_VALUES.has(spec.fileFlag)).toBe(true)
      expect(FLAGS_NO_VALUE.has(spec.noFlag)).toBe(true)
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

  // ---- regression: --credential-name must not leak into prompt ----------

  describe("--credential-name must consume its value (regression for broken live area on resume)", () => {
    test("--credential-name <name> alone → none (interactive REPL)", () => {
      expect(extractPromptFromArgs(["--credential-name", "work-credential-2"])).toEqual({
        kind: "none",
      })
    })

    test("--credential-name <name> with --resume → none (interactive REPL)", () => {
      expect(
        extractPromptFromArgs(["--resume", "last", "--credential-name", "work-credential-2"]),
      ).toEqual({ kind: "none" })
    })

    test("--credential-name + bare positional → that positional is the prompt", () => {
      expect(extractPromptFromArgs(["--credential-name", "work", "say hi"])).toEqual({
        kind: "literal",
        text: "say hi",
      })
    })
  })

  // ---- regression: --output-schema must consume its value ---------------

  test("--output-schema <file> alone → none", () => {
    expect(extractPromptFromArgs(["--output-schema", "/tmp/schema.json"])).toEqual({
      kind: "none",
    })
  })

  // ---- regression: --output-format must consume its value ---------------
  //
  // `--output-format` takes a value (text|json|stream-json). Without it in
  // FLAGS_WITH_VALUES the positional walk would mistake "json" for the prompt,
  // so `minimal-agent --output-format json "hi"` would run "json" as the prompt
  // and drop the real one — the exact class of bug this module prevents.

  test("--output-format json <prompt> → the prompt is the positional, not 'json'", () => {
    expect(extractPromptFromArgs(["--output-format", "json", "hi"])).toEqual({
      kind: "literal",
      text: "hi",
    })
  })

  test("--output-format stream-json <prompt> → positional is the prompt", () => {
    expect(extractPromptFromArgs(["--output-format", "stream-json", "do the thing"])).toEqual({
      kind: "literal",
      text: "do the thing",
    })
  })

  test("--output-format json alone → none (interactive REPL)", () => {
    expect(extractPromptFromArgs(["--output-format", "json"])).toEqual({ kind: "none" })
  })

  test("normalized `--output-format=json` + bare positional → positional is the prompt", () => {
    expect(extractPromptFromArgs(normalizeArgs(["--output-format=json", "hi"]))).toEqual({
      kind: "literal",
      text: "hi",
    })
  })

  // ---- regression: --service-tier must consume its value ----------------

  test("--service-tier <tier> alone → none", () => {
    expect(extractPromptFromArgs(["--service-tier", "flex"])).toEqual({ kind: "none" })
  })

  // ---- regression: --platform must consume its value --------------------

  test("--platform <os> alone → none", () => {
    expect(extractPromptFromArgs(["--platform", "macos"])).toEqual({ kind: "none" })
  })
})
