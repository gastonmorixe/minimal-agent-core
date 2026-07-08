/**
 * End-to-end test: system-prompt override flags must never be misread as the
 * user's prompt.
 *
 * The regression class is the `extract-prompt` trap Andres flagged: a
 * value-taking flag missing from FLAGS_WITH_VALUES (or a `--no-*` flag missing
 * from FLAGS_NO_VALUE) causes its value/successor to be swallowed as a bare
 * positional prompt, silently forcing the agent into non-interactive mode.
 *
 * This drives the REAL startup path (`prepareEntrypointArgs` → normalizeArgs →
 * parseCliOptions → extractPromptFromArgs) and asserts both that the prompt is
 * classified correctly AND that the overrides struct is populated as expected.
 *
 * @module e2e/system-prompt-override-e2e.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS } from "../cli/system-prompt-override-flags.ts"
import { prepareEntrypointArgs } from "../host/startup/entry-args.ts"

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

function harness() {
  const writes: string[] = []
  return {
    writes,
    deps: {
      stderr: { write: (s: string) => (writes.push(s), true) as unknown as boolean },
      exit: (code: number): never => {
        throw new ExitSignal(code)
      },
      printHelp: () => {},
    },
  }
}

describe("system-prompt override flags do not leak into the user prompt", () => {
  it("every value-taking override flag consumes its value (interactive REPL)", async () => {
    for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
      // Provider preamble needs the unsafe opt-in, otherwise it exits 2.
      const unsafe = spec.part === "providerPreamble" ? ["--unsafe-system-prompt-overrides"] : []
      const h = harness()
      const prepared = prepareEntrypointArgs({
        rawArgv: [spec.valueFlag, "OVERRIDE VALUE", ...unsafe],
        env: {},
        cwd: "/tmp",
        ...h.deps,
      })
      // The override value must NOT become the prompt.
      expect(await prepared.extractPrompt()).toBeNull()
    }
  })

  it("every file-taking override flag consumes its path (interactive REPL)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-sp-override-e2e-"))
    try {
      const filePath = join(dir, "override.md")
      writeFileSync(filePath, "file contents")
      for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
        const unsafe = spec.part === "providerPreamble" ? ["--unsafe-system-prompt-overrides"] : []
        const h = harness()
        const prepared = prepareEntrypointArgs({
          rawArgv: [spec.fileFlag, filePath, ...unsafe],
          env: {},
          cwd: "/tmp",
          ...h.deps,
        })
        // The file path must NOT become the prompt.
        expect(prepared.opts.systemPromptOverrides[spec.part]).toEqual({
          kind: "replace",
          text: "file contents",
        })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("override flag value + real positional prompt keeps the positional", async () => {
    const h = harness()
    const prepared = prepareEntrypointArgs({
      rawArgv: ["--system-instructions", "custom instructions", "the real prompt"],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(await prepared.extractPrompt()).toBe("the real prompt")
    expect(prepared.opts.systemPromptOverrides.instructions).toEqual({
      kind: "replace",
      text: "custom instructions",
    })
  })

  it("--no-* override flags never swallow the next positional", async () => {
    for (const spec of SYSTEM_PROMPT_OVERRIDE_FLAG_SPECS) {
      const unsafe = spec.part === "providerPreamble" ? ["--unsafe-system-prompt-overrides"] : []
      const h = harness()
      const prepared = prepareEntrypointArgs({
        rawArgv: [spec.noFlag, "the real prompt", ...unsafe],
        env: {},
        cwd: "/tmp",
        ...h.deps,
      })
      expect(await prepared.extractPrompt()).toBe("the real prompt")
      expect(prepared.opts.systemPromptOverrides[spec.part]).toEqual({ kind: "omit" })
    }
  })

  it("combined overrides + --prompt: prompt wins, overrides resolve", async () => {
    const h = harness()
    const prepared = prepareEntrypointArgs({
      rawArgv: [
        "--system-identity",
        "ID",
        "--no-system-loop-safety",
        "--prompt",
        "explicit prompt",
      ],
      env: {},
      cwd: "/tmp",
      ...h.deps,
    })
    expect(await prepared.extractPrompt()).toBe("explicit prompt")
    expect(prepared.opts.systemPromptOverrides.identity).toEqual({ kind: "replace", text: "ID" })
    expect(prepared.opts.systemPromptOverrides.loopSafety).toEqual({ kind: "omit" })
  })

  it("missing override file exits 2 with a clean startup error", () => {
    const h = harness()
    let code: number | undefined
    try {
      prepareEntrypointArgs({
        rawArgv: ["--system-instructions-file", "/nonexistent/path/to/override.md"],
        env: {},
        cwd: "/tmp",
        ...h.deps,
      })
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    }
    expect(code).toBe(2)
    expect(h.writes.join("")).toContain("system prompt override")
  })
})
