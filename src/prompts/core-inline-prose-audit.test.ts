/**
 * Core inline-prose audit.
 *
 * The house rule (memory: PROMPT HYGIENE, Alex 2026-07-02): model-facing
 * text must not live inline in a `.ts` logic file. Since the core-prompts
 * decouple (P3.3) the synthetic texts live in plugins (synthetic text
 * providers), and core asks for a kind with data facts. This test is the
 * regression guard for core `src/`: it (1) confirms the old colocated
 * `PROMPTS.ts` seams stay deleted, and (2) refuses to let the specific
 * literals that were externalized creep back into core logic files.
 *
 * Scope is deliberately core-only. The sibling `minimal-agent-plugins` repo
 * runs its own prompt-audit; `src/prompts/prompt-audit.test.ts` covers the
 * markdown fragments. This file covers the deleted `PROMPTS.ts` seams.
 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

const ROOT = resolve(import.meta.dir, "..", "..")

/** The old colocated PROMPTS.ts seams. Deleted in P3.3: the text is plugin-owned. */
const DELETED_PROMPTS_SEAMS = [
  "src/agent/PROMPTS.ts",
  "src/tools/PROMPTS.ts",
  "src/media/PROMPTS.ts",
  "src/modes/PROMPTS.ts",
  "src/plugins/loader/PROMPTS.ts",
]

/**
 * Logic files that had inline model-facing prose extracted (first into a
 * PROMPTS.ts seam, now into plugins), mapped to literal fragments that must
 * never reappear inline.
 */
const EXTRACTED_FRAGMENTS: Record<string, string[]> = {
  "src/tools/tools.ts": [
    "tool aborted by user",
    "Mode tool reached the dispatcher",
    "reflection-ack applied",
    "No files matched the pattern.",
    "No matches found.",
    "Glob requires `pattern` (or alias `glob_pattern`).",
    "Use replace_all or provide more context",
    "exceeds the 50 MB read limit",
  ],
  "src/tools/truncation.ts": ["[truncated: shown "],
  "src/tools/feedback-tracker.ts": ["you've truncated"],
  "src/media/limits.ts": ["doesn't accept", "isn't a supported type"],
  "src/media/read-file.ts": ["binary document", "doesn't accept image input"],
  "src/modes/modes.ts": ["is not permitted in ${"],
  "src/sdk/agent-core.ts": [
    "<ma::agent::turn-aborted />\\n",
    "output-truncated />\\n",
    "emergency-cap-triggered",
  ],
  "src/agent/reflection.ts": ["Soft checkpoint, not a stop signal"],
  "src/tools/tool-result-text.ts": [
    "the user only saw a fraction",
    "The full untruncated output is saved at",
    "<ma::agent::output-preview shown=",
  ],
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
  test("the old PROMPTS.ts seams are absent", () => {
    const present = DELETED_PROMPTS_SEAMS.filter((rel) => existsSync(join(ROOT, rel)))
    expect(present).toEqual([])
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
