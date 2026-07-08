/**
 * Core inline-prose audit.
 *
 * The house rule (memory: PROMPT HYGIENE, Gaston 2026-07-02): model-facing
 * text must not live inline in a `.ts` logic file. It belongs in an external
 * markdown / template file (loaded via `renderPrompt`) or, for one-line wire
 * shapes and interpolated error strings, in a colocated `PROMPTS.ts` that
 * exports only string constants and pure string builders. This test is the
 * regression guard for core `src/`: it (1) confirms the colocated seams
 * exist, (2) style-checks the prose those seams emit, and (3) refuses to let
 * the specific literals that were externalized creep back into the logic
 * files they came from.
 *
 * Scope is deliberately core-only. The sibling `minimal-agent-plugins` repo
 * runs its own prompt-audit; `src/prompts/prompt-audit.test.ts` covers the
 * markdown fragments. This file covers the `PROMPTS.ts` seam + its consumers.
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

const ROOT = resolve(import.meta.dir, "..", "..")

/** Colocated PROMPTS.ts seams that hold core model-facing prose. */
const PROMPTS_SEAMS = [
  "src/agent/PROMPTS.ts",
  "src/tools/PROMPTS.ts",
  "src/media/PROMPTS.ts",
  "src/modes/PROMPTS.ts",
  "src/plugins/loader/PROMPTS.ts",
]

/**
 * Logic files that had inline model-facing prose extracted into a PROMPTS.ts
 * seam, mapped to literal fragments that must never reappear inline. If a
 * refactor reintroduces one of these, the string moved back into the logic
 * file and the seam was bypassed.
 */
const EXTRACTED_FRAGMENTS: Record<string, string[]> = {
  "src/tools/tools.ts": [
    "tool aborted by user",
    "Mode tool reached the dispatcher",
    "reflection-ack applied",
    "No files matched the pattern.",
    "No matches found.",
    "Use replace_all or provide more context",
    "exceeds the 50 MB read limit",
  ],
  "src/tools/truncation.ts": ["[truncated: shown "],
  "src/tools/feedback-tracker.ts": ["you've truncated"],
  "src/host/ui/tool-transcript/format.ts": ["the user only saw a fraction"],
  "src/media/limits.ts": ["doesn't accept", "isn't a supported type"],
  "src/media/read-file.ts": ["binary document", "doesn't accept image input"],
  "src/modes/modes.ts": ["is not permitted in ${"],
  "src/agent/agent.ts": [
    "<ma::agent::turn-aborted />\\n",
    "output-truncated />\\n",
    "emergency-cap-triggered",
  ],
  "src/sdk/agent-core.ts": [
    "<ma::agent::turn-aborted />\\n",
    "output-truncated />\\n",
    "emergency-cap-triggered",
  ],
  "src/agent/reflection.ts": ["Soft checkpoint, not a stop signal"],
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
}

/**
 * Strip `//` line comments and block comments so the reintroduction check
 * only sees executable code, not JSDoc examples that legitimately quote the
 * old string shapes (a module docstring showing `{ content: "..." }` is
 * documentation, not a bypassed prompt seam).
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("core inline-prose audit", () => {
  test("every PROMPTS.ts seam exists and exports prose", () => {
    for (const rel of PROMPTS_SEAMS) {
      const text = read(rel)
      expect(text.length).toBeGreaterThan(0)
      // A seam exports either string constants or string-returning builders.
      expect(text).toMatch(/export (function|const)/)
    }
  })

  test("PROMPTS.ts prose carries no typographic punctuation drift", () => {
    // Same rule the markdown audit enforces: straight quotes, no em/en dashes,
    // no smart quotes, no ellipsis glyph. These strings reach the model.
    const bad: string[] = []
    for (const rel of PROMPTS_SEAMS) {
      const text = read(rel)
      const re = /[\u2014\u2013\u2192\u2026\u201c\u201d\u2018\u2019]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split("\n").length
        bad.push(`${rel}:${line} ${m[0]}`)
      }
    }
    expect(bad).toEqual([])
  })

  test("extracted prose is not reintroduced inline in logic files", () => {
    const bad: string[] = []
    for (const [rel, fragments] of Object.entries(EXTRACTED_FRAGMENTS)) {
      const text = stripComments(read(rel))
      for (const fragment of fragments) {
        if (text.includes(fragment))
          bad.push(`${rel}: reintroduced inline prose ${JSON.stringify(fragment)}`)
      }
    }
    expect(bad).toEqual([])
  })
})
