/**
 * Kind and facts table for the built-in tool result texts (core-prompts
 * decouple P1.3 and P3.2, review MAJOR-3). One row per synthetic.json entry
 * of the old tools file and of the read-file part of the old media file.
 *
 * For each fixture case, a recording stub provider owns the kind. The core
 * path called with the fixture args asks for exactly the row kind with
 * exactly the expected facts, the keys are the documented ones (plugin-api
 * synthetic-text.ts), and every value is data (number, string, boolean).
 * The text compare lives in minimal-agent-plugins
 * (ma-core-tools-plugin/parity.test.ts).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import { createSyntheticTextResolver, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import {
  binaryRejectedText,
  imageSummaryText,
  imageTooLargeText,
  unsupportedEmbeddingText,
  unsupportedImageModalityText,
} from "../media/read-file.ts"
import { SIBLING_REPO_ROOT } from "../test-utils/sibling-repo.ts"

import { ToolFeedbackTracker } from "./feedback-tracker.ts"
import * as T from "./tool-result-text.ts"
import { executeTool } from "./tools.ts"

const FIXTURE = join(SIBLING_REPO_ROOT, "tests", "text-parity", "fixtures", "synthetic.json")

interface FixtureCase {
  args: unknown[]
  text: string
}
interface FixtureEntry {
  fn: string
  file: string
  proposedKind: string
  cases: FixtureCase[]
}

const hasFixture = existsSync(FIXTURE)
const entries: FixtureEntry[] = hasFixture
  ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as { entries: FixtureEntry[] }).entries
  : []

/** The read-file part of the old media text file. The rest is user_media.* (step 1.5). */
const READ_FILE_FNS = new Set([
  "binaryDocumentRejectedMessage",
  "unsupportedEmbeddingMessage",
  "unsupportedImageModalityMessage",
  "fittedImageTooLargeMessage",
  "imageSummaryMessage",
])

const rows = entries.filter(
  (e) =>
    e.file.startsWith("src/tools/") || (e.file.startsWith("src/media/") && READ_FILE_FNS.has(e.fn)),
)

/** The truncationHint fixture case whose text is `hint`. */
function truncationHintCase(hint: string): FixtureCase {
  const hit = entries.find((e) => e.fn === "truncationHint")?.cases.find((c) => c.text === hint)
  if (!hit) throw new Error(`no truncationHint fixture for ${hint}`)
  return hit
}

type Text = SyntheticTextResolver
type Obj = Record<string, unknown>

/**
 * How one fixture case runs through the core path. `text` is the recording
 * resolver. `facts` maps the fixture args to the exact facts the core path
 * must pass for `kind`.
 */
interface Row {
  kind: SyntheticKind
  run: (text: Text, args: unknown[]) => string | Promise<string>
  facts: (args: unknown[]) => SyntheticFacts
}

const s = (v: unknown): string => v as string
const n = (v: unknown): number => v as number

const ROWS: Record<string, Row> = {
  bashErrorResult: {
    kind: "tool_text.Bash.error",
    facts: (a) => ({ detail: s(a[0]) }),
    run: (t, a) => T.bashErrorText(t, s(a[0])),
  },
  bashExitCodeResult: {
    kind: "tool_text.Bash.exit_code",
    facts: (a): SyntheticFacts => (a[0] === null ? {} : { exitCode: n(a[0]) }),
    run: (t, a) => T.bashExitCodeText(t, a[0] as number | null),
  },
  bashOutputCapMarker: {
    kind: "tool_text.Bash.output_cap",
    facts: (a) => ({ maxBytes: n(a[0]) }),
    run: (t, a) => T.bashOutputCapText(t, n(a[0])),
  },
  bashTimedOutMarker: {
    kind: "tool_text.Bash.timed_out",
    facts: (a) => ({ timeoutMs: n(a[0]) }),
    run: (t, a) => T.bashTimedOutText(t, n(a[0])),
  },
  cdNoSuchDirectoryResult: {
    kind: "tool_text.Bash.cd_no_dir",
    facts: (a) => ({ path: s(a[0]) }),
    run: (t, a) => T.bashCdNoDirText(t, s(a[0])),
  },
  editErrorResult: {
    kind: "tool_text.Edit.error",
    facts: (a) => ({ detail: s(a[0]) }),
    run: (t, a) => T.editErrorText(t, s(a[0])),
  },
  editOldStringMultipleMatchesResult: {
    kind: "tool_text.Edit.multiple",
    facts: (a) => ({ count: n(a[0]), path: s(a[1]) }),
    run: (t, a) => T.editMultipleText(t, n(a[0]), s(a[1])),
  },
  editOldStringNotFoundResult: {
    kind: "tool_text.Edit.not_found",
    facts: (a) => ({ path: s(a[0]) }),
    run: (t, a) => T.editNotFoundText(t, s(a[0])),
  },
  fileEditedResult: {
    kind: "tool_text.Edit.edited",
    facts: (a) => ({ path: s(a[0]), replacements: n(a[1]) }),
    run: (t, a) => T.editEditedText(t, s(a[0]), n(a[1])),
  },
  fileWrittenResult: {
    kind: "tool_text.Write.written",
    facts: (a) => ({ path: s(a[0]) }),
    run: (t, a) => T.writeWrittenText(t, s(a[0])),
  },
  globArgNotStringResult: {
    kind: "tool_text.Glob.arg_not_string",
    facts: (a) => ({ key: s(a[0]), got: s(a[1]) }),
    run: (t, a) => T.globArgNotStringText(t, s(a[0]), s(a[1])),
  },
  globErrorResult: {
    kind: "tool_text.Glob.error",
    facts: (a) => ({ detail: s(a[0]) }),
    run: (t, a) => T.globErrorText(t, s(a[0])),
  },
  globMissingPatternResult: {
    kind: "tool_text.Glob.missing_pattern",
    facts: () => ({}),
    run: (t) => T.globMissingPatternText(t),
  },
  globSkippedDirsNotice: {
    kind: "tool_text.Glob.skipped_dirs",
    facts: (a) => ({ count: n(a[0]) }),
    run: (t, a) => T.globSkippedDirsText(t, n(a[0])),
  },
  globTimeoutNotice: {
    kind: "tool_text.Glob.timeout",
    facts: (a) => ({ ms: n(a[0]), skippedDirs: n(a[1]) }),
    run: (t, a) => T.globTimeoutText(t, n(a[0]), n(a[1])),
  },
  grepErrorResult: {
    kind: "tool_text.Grep.error",
    facts: (a) => ({ detail: s(a[0]) }),
    run: (t, a) => T.grepErrorText(t, s(a[0])),
  },
  lockAcquireFailedResult: {
    kind: "tool_result.lock_failed",
    facts: (a) => ({ tool: s(a[0]), detail: s(a[1]) }),
    run: (t, a) => T.lockFailedText(t, s(a[0]), s(a[1])),
  },
  lockTimeoutResult: {
    kind: "tool_result.lock_timeout",
    facts: (a) => ({ tool: s(a[0]), detail: s(a[1]) }),
    run: (t, a) => T.lockTimeoutText(t, s(a[0]), s(a[1])),
  },
  modeToolDispatcherBugResult: {
    kind: "tool_result.no_executor",
    facts: () => ({ name: "Mode", site: "dispatcher" }),
    run: (t) => T.modeNoExecutorText(t),
  },
  noFilesMatchedResult: {
    kind: "tool_text.Glob.no_files",
    facts: () => ({}),
    run: (t) => T.globNoFilesText(t),
  },
  noMatchesFoundResult: {
    kind: "tool_text.Grep.no_matches",
    facts: () => ({}),
    run: (t) => T.grepNoMatchesText(t),
  },
  outputPreviewAnnotation: {
    kind: "tool_output.preview",
    run: (t, a) => {
      const o = a[0] as Obj
      const rawPath = s(o.path ?? "")
      const tag = T.previewTagText(t, {
        shown: n(o.shown),
        total: n(o.total),
        tool: s(o.tool),
        ...(rawPath ? { rawPath } : {}),
      })
      return `${s(o.content)}\n\n${tag}`
    },
    facts: (a) => {
      const o = a[0] as Obj
      const rawPath = s(o.path ?? "")
      const base = {
        shown: n(o.shown),
        total: n(o.total),
        tool: s(o.tool),
        bash: o.tool === "Bash",
      }
      return rawPath ? { ...base, rawPath } : base
    },
  },
  readErrorResult: {
    kind: "tool_text.Read.error",
    facts: (a) => ({ detail: s(a[0]) }),
    run: (t, a) => T.readErrorText(t, s(a[0])),
  },
  readTooLargeResult: {
    kind: "tool_text.Read.too_large",
    facts: (a) => ({ sizeMb: s(a[0]), limitMb: n(a[1]) }),
    run: (t, a) => T.readTooLargeText(t, s(a[0]), n(a[1])),
  },
  reflectionAckToolResult: {
    kind: "runtime.reflection_ack_result",
    facts: () => ({}),
    run: (t) => T.reflectionAckText(t),
  },
  streakNote: {
    kind: "tool_output.streak",
    facts: (a) => ({ tool: s(a[0]), threshold: n(a[1]) }),
    run: (t, a) => {
      const tracker = new ToolFeedbackTracker(n(a[1]))
      let note: string | null = null
      for (let i = 0; i < n(a[1]); i++) note = tracker.observe(s(a[0]), true, t)
      return note ?? ""
    },
  },
  toolAbortedByUserResult: {
    kind: "tool_result.aborted",
    facts: () => ({ site: "runtime" }),
    run: (t) => T.abortedText(t),
  },
  truncatedOutputNotice: {
    kind: "tool_output.truncated",
    run: (t, a) => {
      const o = a[0] as Obj
      // The old fn took the hint and string totals. Core passes number
      // totals and renders the hint from the tool. A hint of "" maps to no
      // tool case, so the tool comes from the hint fixture when there is one.
      const hint = s(o.hint)
      const tool = hint === "" ? "" : s(truncationHintCase(hint).args[0] ?? "")
      // "unknown" totals: a template-only case, skipped for facts (see the
      // table). Core always has number totals.
      const notice = T.truncatedNoticeText(t, {
        tool,
        shownBytes: n(o.shownBytes),
        totalBytes: (/^\d+$/.test(s(o.totalBytes)) ? Number(o.totalBytes) : o.totalBytes) as number,
        shownLines: n(o.shownLines),
        totalLines: (/^\d+$/.test(s(o.totalLines)) ? Number(o.totalLines) : o.totalLines) as number,
        cutLine: n(o.cutLine),
        maxToolOutputBytes: 65536,
      })
      return `${s(o.kept)}\n\n${notice}`
    },
    facts: (a) => {
      const o = a[0] as Obj
      const hint = s(o.hint)
      return {
        tool: hint === "" ? "" : s(truncationHintCase(hint).args[0] ?? ""),
        shownBytes: n(o.shownBytes),
        totalBytes: Number(o.totalBytes),
        shownLines: n(o.shownLines),
        totalLines: Number(o.totalLines),
        cutLine: n(o.cutLine),
        maxToolOutputBytes: 65536,
      }
    },
  },
  truncationHint: {
    // Folded into tool_output.truncated: the hint is the end of the notice.
    kind: "tool_output.truncated",
    run: (t, a) => {
      const notice = T.truncatedNoticeText(t, {
        tool: s(a[0] ?? ""),
        shownBytes: 1,
        totalBytes: 2,
        shownLines: 1,
        totalLines: 2,
        cutLine: n(a[1]),
        maxToolOutputBytes: n(a[2]),
      })
      return notice
    },
    facts: (a) => ({
      tool: s(a[0] ?? ""),
      shownBytes: 1,
      totalBytes: 2,
      shownLines: 1,
      totalLines: 2,
      cutLine: n(a[1]),
      maxToolOutputBytes: n(a[2]),
    }),
  },
  tuiPreviewHint: {
    // Folded into tool_output.preview: the hint is the body of the tag.
    kind: "tool_output.preview",
    run: (t, a) => {
      const rawPath = s(a[1] ?? "")
      const tag = T.previewTagText(t, {
        shown: 1,
        total: 2,
        tool: s(a[0]),
        ...(rawPath ? { rawPath } : {}),
      })
      return tag
    },
    facts: (a) => {
      const rawPath = s(a[1] ?? "")
      const base = { shown: 1, total: 2, tool: s(a[0]), bash: a[0] === "Bash" }
      return rawPath ? { ...base, rawPath } : base
    },
  },
  unknownToolResult: {
    kind: "tool_result.unknown_tool",
    facts: (a) => ({ name: s(a[0]) }),
    run: (t, a) => T.unknownToolText(t, s(a[0])),
  },
  whitespaceResolvedNote: {
    kind: "tool_text.Read.whitespace_resolved",
    facts: (a) => ({ path: s(a[0]) }),
    run: (t, a) => T.readWhitespaceText(t, s(a[0])),
  },
  writeArgNotStringResult: {
    kind: "tool_text.Write.arg_not_string",
    facts: (a) => ({ key: s(a[0]), got: s(a[1]) }),
    run: (t, a) => T.writeArgNotStringText(t, s(a[0]), s(a[1])),
  },
  writeErrorResult: {
    kind: "tool_text.Write.error",
    facts: (a) => ({ detail: s(a[0]) }),
    run: (t, a) => T.writeErrorText(t, s(a[0])),
  },
  writeMissingContentResult: {
    kind: "tool_text.Write.missing_content",
    facts: () => ({}),
    run: (t) => T.writeMissingContentText(t),
  },
  writeMissingPathResult: {
    kind: "tool_text.Write.missing_path",
    facts: () => ({}),
    run: (t) => T.writeMissingPathText(t),
  },
  binaryDocumentRejectedMessage: {
    kind: "tool_text.Read.binary_rejected",
    facts: (a) => ({ ...(a[0] as Obj) }) as SyntheticFacts,
    run: (t, a) => binaryRejectedText(t, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedEmbeddingMessage: {
    kind: "tool_text.Read.unsupported_embedding",
    facts: (a) => ({ ...(a[0] as Obj) }) as SyntheticFacts,
    run: (t, a) => unsupportedEmbeddingText(t, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedImageModalityMessage: {
    kind: "tool_text.Read.unsupported_image_modality",
    facts: (a) => ({ ...(a[0] as Obj) }) as SyntheticFacts,
    run: (t, a) =>
      unsupportedImageModalityText(
        t,
        a[0] as { modelId: string; mimeType: string; sizeBytes: number },
      ),
  },
  fittedImageTooLargeMessage: {
    kind: "tool_text.Read.image_too_large",
    facts: (a) => ({ ...(a[0] as Obj) }) as SyntheticFacts,
    run: (t, a) =>
      imageTooLargeText(t, a[0] as { sizeBytes: number; limitBytes: number; modelId: string }),
  },
  imageSummaryMessage: {
    kind: "tool_text.Read.image_summary",
    facts: (a) => {
      const o = a[0] as Obj
      const dims = o.dimensions as { width: number; height: number } | null
      return {
        subtype: s(o.subtype),
        sizeBytes: n(o.sizeBytes),
        ...(dims ? { width: dims.width, height: dims.height } : {}),
        ...(o.fittedStrategy ? { fittedStrategy: s(o.fittedStrategy) } : {}),
      }
    },
    run: (t, a) =>
      imageSummaryText(
        t,
        a[0] as {
          subtype: string
          sizeBytes: number
          dimensions: { width: number; height: number } | null
          fittedStrategy: string | null
        },
      ),
  },
}

/**
 * The documented facts per kind (plugin-api types/synthetic-text.ts). `?`
 * marks an optional key.
 */
const DOC: Partial<Record<SyntheticKind, string[]>> = {
  "tool_output.preview": ["shown", "total", "tool", "bash", "rawPath?"],
  "tool_output.truncated": [
    "tool",
    "shownBytes",
    "totalBytes",
    "shownLines",
    "totalLines",
    "cutLine",
    "maxToolOutputBytes",
  ],
  "tool_output.streak": ["tool", "threshold"],
  "runtime.reflection_ack_result": [],
  "tool_result.aborted": ["site"],
  "tool_result.unknown_tool": ["name", "plugin?"],
  "tool_result.no_executor": ["name", "site"],
  "tool_result.lock_timeout": ["tool", "detail"],
  "tool_result.lock_failed": ["tool", "detail"],
  "tool_text.Bash.cd_no_dir": ["path"],
  "tool_text.Bash.output_cap": ["maxBytes"],
  "tool_text.Bash.timed_out": ["timeoutMs"],
  "tool_text.Bash.exit_code": ["exitCode?"],
  "tool_text.Bash.error": ["detail"],
  "tool_text.Read.whitespace_resolved": ["path"],
  "tool_text.Read.too_large": ["sizeMb", "limitMb"],
  "tool_text.Read.error": ["detail"],
  "tool_text.Read.binary_rejected": ["mimeType", "sizeBytes"],
  "tool_text.Read.unsupported_embedding": ["mimeType", "sizeBytes"],
  "tool_text.Read.unsupported_image_modality": ["modelId", "mimeType", "sizeBytes"],
  "tool_text.Read.image_too_large": ["sizeBytes", "limitBytes", "modelId"],
  "tool_text.Read.image_summary": ["subtype", "sizeBytes", "width?", "height?", "fittedStrategy?"],
  "tool_text.Write.written": ["path"],
  "tool_text.Write.error": ["detail"],
  "tool_text.Write.missing_path": [],
  "tool_text.Write.missing_content": [],
  "tool_text.Write.arg_not_string": ["key", "got"],
  "tool_text.Edit.not_found": ["path"],
  "tool_text.Edit.multiple": ["count", "path"],
  "tool_text.Edit.edited": ["path", "replacements"],
  "tool_text.Edit.error": ["detail"],
  "tool_text.Glob.no_files": [],
  "tool_text.Glob.missing_pattern": [],
  "tool_text.Glob.arg_not_string": ["key", "got"],
  "tool_text.Glob.error": ["detail"],
  "tool_text.Glob.timeout": ["ms", "skippedDirs"],
  "tool_text.Glob.skipped_dirs": ["count"],
  "tool_text.Grep.error": ["detail"],
  "tool_text.Grep.no_matches": [],
}

/** A resolver whose one stub provider owns `kind` and records each call. */
function recording(kind: SyntheticKind): {
  text: SyntheticTextResolver
  calls: { kind: SyntheticKind; facts: SyntheticFacts }[]
} {
  const calls: { kind: SyntheticKind; facts: SyntheticFacts }[] = []
  const provider: SyntheticTextProvider = {
    kinds: [kind],
    text: (k, facts) => {
      calls.push({ kind: k, facts })
      return `STUB ${k}`
    },
  }
  return {
    text: createSyntheticTextResolver([provider], createDiagnostics({ emit: () => {} })),
    calls,
  }
}

describe.skipIf(!hasFixture)("tool result text parity table", () => {
  it("every fixture entry has a row, and the row kind is the proposed kind", () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const e of rows) {
      const row = ROWS[e.fn]
      expect(row, e.fn).toBeDefined()
      // proposedKind may carry a fact suffix, e.g. `tool_result.aborted{site:runtime}`.
      expect(e.proposedKind.split("{")[0], e.fn).toBe(row?.kind ?? "")
    }
  })

  for (const e of rows) {
    it(`recording stub: ${e.fn} asks for its kind with the exact facts`, async () => {
      const row = ROWS[e.fn] as Row
      const doc = DOC[row.kind]
      expect(doc, row.kind).toBeDefined()
      const required = (doc ?? []).filter((k) => !k.endsWith("?"))
      const allowed = new Set((doc ?? []).map((k) => k.replace(/\?$/, "")))
      for (const c of e.cases) {
        // "unknown" totals are a template-only case (see the row): skip facts.
        if (JSON.stringify(c.args).includes('"unknown"')) continue
        const rec = recording(row.kind)
        const out = await row.run(rec.text, c.args)
        expect(out, e.fn).toContain(`STUB ${row.kind}`)
        expect(rec.calls, e.fn).toEqual([{ kind: row.kind, facts: row.facts(c.args) }])
        const facts = rec.calls[0]?.facts ?? {}
        for (const key of required) expect(Object.hasOwn(facts, key), `${e.fn} ${key}`).toBe(true)
        for (const [key, value] of Object.entries(facts)) {
          expect(allowed.has(key), `${e.fn} extra ${key}`).toBe(true)
          expect(["number", "string", "boolean"]).toContain(typeof value)
        }
      }
    })
  }
})

describe("Write and Glob input errors reach the resolver (MAJOR-1)", () => {
  it("tool_text.Write.missing_path through executeTool", async () => {
    const rec = recording("tool_text.Write.missing_path")
    const r = await executeTool("Write", { content: "x" }, { text: rec.text })
    expect(r).toMatchObject({ content: "STUB tool_text.Write.missing_path", is_error: true })
    expect(rec.calls).toEqual([{ kind: "tool_text.Write.missing_path", facts: {} }])
  })

  it("tool_text.Glob.missing_pattern through executeTool", async () => {
    const rec = recording("tool_text.Glob.missing_pattern")
    const r = await executeTool("Glob", {}, { text: rec.text })
    expect(r).toMatchObject({ content: "STUB tool_text.Glob.missing_pattern", is_error: true })
    expect(rec.calls).toEqual([{ kind: "tool_text.Glob.missing_pattern", facts: {} }])
  })
})
