/**
 * Parity table for the built-in tool result texts (core-prompts decouple
 * P1.3, review MAJOR-3). One row per synthetic.json entry of
 * `src/tools/PROMPTS.ts` and of the read-file part of `src/media/PROMPTS.ts`.
 *
 * Pass 1: the core path with no provider, called with the fixture args,
 * gives the fixture text.
 * Pass 2: a recording stub provider owns the kind. The facts the core path
 * passes have exactly the documented keys (plugin-api synthetic-text.ts),
 * and every value is data (number, string, boolean).
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

import { ToolFeedbackTracker } from "./feedback-tracker.ts"
import * as T from "./tool-result-text.ts"
import { executeTool } from "./tools.ts"

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "minimal-agent-plugins",
  "tests",
  "text-parity",
  "fixtures",
  "synthetic.json",
)

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

/** The read-file part of media/PROMPTS.ts. The rest is user_media.* (step 1.5). */
const READ_FILE_FNS = new Set([
  "binaryDocumentRejectedMessage",
  "unsupportedEmbeddingMessage",
  "unsupportedImageModalityMessage",
  "fittedImageTooLargeMessage",
  "imageSummaryMessage",
])

const rows = entries.filter(
  (e) =>
    e.file === "src/tools/PROMPTS.ts" ||
    (e.file === "src/media/PROMPTS.ts" && READ_FILE_FNS.has(e.fn)),
)

/** The tuiPreviewHint fixture text for a tool and a raw path. */
function previewHint(tool: string, rawPath: string | undefined): string {
  const cases = entries.find((e) => e.fn === "tuiPreviewHint")?.cases ?? []
  const key = tool === "Bash" ? "Bash" : "Read"
  const hit = cases.find((c) => c.args[0] === key && (c.args[1] ?? "") === (rawPath ?? ""))
  if (!hit) throw new Error(`no tuiPreviewHint fixture for ${key} ${rawPath}`)
  return hit.text
}

/** The truncationHint fixture case whose text is `hint`. */
function truncationHintCase(hint: string): FixtureCase {
  const hit = entries.find((e) => e.fn === "truncationHint")?.cases.find((c) => c.text === hint)
  if (!hit) throw new Error(`no truncationHint fixture for ${hint}`)
  return hit
}

type Text = SyntheticTextResolver | undefined
type Obj = Record<string, unknown>

/**
 * How one fixture case runs through the core path. `text` is the resolver
 * (undefined: no provider). `expect` maps the fixture text to the text the
 * core path must give. It is the fixture text, except where the old fn took
 * a hint as an argument: the core path now renders that hint itself, so the
 * fixture hint is swapped for the hint fixture of the same tool.
 */
interface Row {
  kind: SyntheticKind
  run: (text: Text, args: unknown[]) => string | Promise<string>
  expect?: (c: FixtureCase) => string
}

const s = (v: unknown): string => v as string
const n = (v: unknown): number => v as number

const ROWS: Record<string, Row> = {
  bashErrorResult: { kind: "tool_text.Bash.error", run: (t, a) => T.bashErrorText(t, s(a[0])) },
  bashExitCodeResult: {
    kind: "tool_text.Bash.exit_code",
    run: (t, a) => T.bashExitCodeText(t, a[0] as number | null),
  },
  bashOutputCapMarker: {
    kind: "tool_text.Bash.output_cap",
    run: (t, a) => T.bashOutputCapText(t, n(a[0])),
  },
  bashTimedOutMarker: {
    kind: "tool_text.Bash.timed_out",
    run: (t, a) => T.bashTimedOutText(t, n(a[0])),
  },
  cdNoSuchDirectoryResult: {
    kind: "tool_text.Bash.cd_no_dir",
    run: (t, a) => T.bashCdNoDirText(t, s(a[0])),
  },
  editErrorResult: { kind: "tool_text.Edit.error", run: (t, a) => T.editErrorText(t, s(a[0])) },
  editOldStringMultipleMatchesResult: {
    kind: "tool_text.Edit.multiple",
    run: (t, a) => T.editMultipleText(t, n(a[0]), s(a[1])),
  },
  editOldStringNotFoundResult: {
    kind: "tool_text.Edit.not_found",
    run: (t, a) => T.editNotFoundText(t, s(a[0])),
  },
  fileEditedResult: {
    kind: "tool_text.Edit.edited",
    run: (t, a) => T.editEditedText(t, s(a[0]), n(a[1])),
  },
  fileWrittenResult: {
    kind: "tool_text.Write.written",
    run: (t, a) => T.writeWrittenText(t, s(a[0])),
  },
  globArgNotStringResult: {
    kind: "tool_text.Glob.arg_not_string",
    run: (t, a) => T.globArgNotStringText(t, s(a[0]), s(a[1])),
  },
  globErrorResult: { kind: "tool_text.Glob.error", run: (t, a) => T.globErrorText(t, s(a[0])) },
  globMissingPatternResult: {
    kind: "tool_text.Glob.missing_pattern",
    run: (t) => T.globMissingPatternText(t),
  },
  globSkippedDirsNotice: {
    kind: "tool_text.Glob.skipped_dirs",
    run: (t, a) => T.globSkippedDirsText(t, n(a[0])),
  },
  globTimeoutNotice: {
    kind: "tool_text.Glob.timeout",
    run: (t, a) => T.globTimeoutText(t, n(a[0]), n(a[1])),
  },
  grepErrorResult: { kind: "tool_text.Grep.error", run: (t, a) => T.grepErrorText(t, s(a[0])) },
  lockAcquireFailedResult: {
    kind: "tool_result.lock_failed",
    run: (t, a) => T.lockFailedText(t, s(a[0]), s(a[1])),
  },
  lockTimeoutResult: {
    kind: "tool_result.lock_timeout",
    run: (t, a) => T.lockTimeoutText(t, s(a[0]), s(a[1])),
  },
  modeToolDispatcherBugResult: {
    kind: "tool_result.no_executor",
    run: (t) => T.modeNoExecutorText(t),
  },
  noFilesMatchedResult: { kind: "tool_text.Glob.no_files", run: (t) => T.globNoFilesText(t) },
  noMatchesFoundResult: { kind: "tool_text.Grep.no_matches", run: (t) => T.grepNoMatchesText(t) },
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
    expect: (c) => {
      const o = c.args[0] as Obj
      const end = `>${s(o.hint)}</ma::agent::output-preview>`
      expect(c.text.endsWith(end)).toBe(true)
      const hint = previewHint(s(o.tool), s(o.path ?? "") || undefined)
      return `${c.text.slice(0, -end.length)}>${hint}</ma::agent::output-preview>`
    },
  },
  readErrorResult: { kind: "tool_text.Read.error", run: (t, a) => T.readErrorText(t, s(a[0])) },
  readTooLargeResult: {
    kind: "tool_text.Read.too_large",
    run: (t, a) => T.readTooLargeText(t, s(a[0]), n(a[1])),
  },
  reflectionAckToolResult: {
    kind: "runtime.reflection_ack_result",
    run: (t) => T.reflectionAckText(t),
  },
  streakNote: {
    kind: "tool_output.streak",
    run: (t, a) => {
      const tracker = new ToolFeedbackTracker(n(a[1]))
      let note: string | null = null
      for (let i = 0; i < n(a[1]); i++) note = tracker.observe(s(a[0]), true, t)
      return note ?? ""
    },
  },
  toolAbortedByUserResult: { kind: "tool_result.aborted", run: (t) => T.abortedText(t) },
  truncatedOutputNotice: {
    kind: "tool_output.truncated",
    run: (t, a) => {
      const o = a[0] as Obj
      // The old fn took the hint and string totals. Core passes number
      // totals and renders the hint from the tool. A hint of "" maps to no
      // tool case, so the tool comes from the hint fixture when there is one.
      const hint = s(o.hint)
      const tool = hint === "" ? "" : s(truncationHintCase(hint).args[0] ?? "")
      // "unknown" totals: the cast checks the template bytes only. Core
      // always has number totals.
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
    expect: (c) => {
      const o = c.args[0] as Obj
      if (s(o.hint) !== "") return c.text
      // An empty hint: core renders the default (no tool) hint instead.
      const fallback = entries.find((e) => e.fn === "truncationHint")?.cases.at(-1)?.text ?? "?"
      expect(c.text.endsWith(". ]")).toBe(true)
      return `${c.text.slice(0, -1)}${fallback}]`
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
      // Cut the hint out of "[truncated: ... line N. <hint>]".
      const head = `line ${n(a[1])}. `
      return notice.slice(notice.indexOf(head) + head.length, -1)
    },
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
      return tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("</ma::agent::output-preview>"))
    },
  },
  unknownToolResult: {
    kind: "tool_result.unknown_tool",
    run: (t, a) => T.unknownToolText(t, s(a[0])),
  },
  whitespaceResolvedNote: {
    kind: "tool_text.Read.whitespace_resolved",
    run: (t, a) => T.readWhitespaceText(t, s(a[0])),
  },
  writeArgNotStringResult: {
    kind: "tool_text.Write.arg_not_string",
    run: (t, a) => T.writeArgNotStringText(t, s(a[0]), s(a[1])),
  },
  writeErrorResult: { kind: "tool_text.Write.error", run: (t, a) => T.writeErrorText(t, s(a[0])) },
  writeMissingContentResult: {
    kind: "tool_text.Write.missing_content",
    run: (t) => T.writeMissingContentText(t),
  },
  writeMissingPathResult: {
    kind: "tool_text.Write.missing_path",
    run: (t) => T.writeMissingPathText(t),
  },
  binaryDocumentRejectedMessage: {
    kind: "tool_text.Read.binary_rejected",
    run: (t, a) => binaryRejectedText(t ?? noText, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedEmbeddingMessage: {
    kind: "tool_text.Read.unsupported_embedding",
    run: (t, a) =>
      unsupportedEmbeddingText(t ?? noText, a[0] as { mimeType: string; sizeBytes: number }),
  },
  unsupportedImageModalityMessage: {
    kind: "tool_text.Read.unsupported_image_modality",
    run: (t, a) =>
      unsupportedImageModalityText(
        t ?? noText,
        a[0] as { modelId: string; mimeType: string; sizeBytes: number },
      ),
  },
  fittedImageTooLargeMessage: {
    kind: "tool_text.Read.image_too_large",
    run: (t, a) =>
      imageTooLargeText(
        t ?? noText,
        a[0] as { sizeBytes: number; limitBytes: number; modelId: string },
      ),
  },
  imageSummaryMessage: {
    kind: "tool_text.Read.image_summary",
    run: (t, a) =>
      imageSummaryText(
        t ?? noText,
        a[0] as {
          subtype: string
          sizeBytes: number
          dimensions: { width: number; height: number } | null
          fittedStrategy: string | null
        },
      ),
  },
}

/** No provider: the read-file helpers take a resolver, not undefined. */
const noText: SyntheticTextResolver = createSyntheticTextResolver(
  [],
  createDiagnostics({ emit: () => {} }),
)

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
  "tool_result.no_executor": ["name"],
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
    it(`no provider: ${e.fn} gives the fixture text`, async () => {
      const row = ROWS[e.fn] as Row
      for (const c of e.cases) {
        const want = row.expect ? row.expect(c) : c.text
        expect(await row.run(undefined, c.args)).toBe(want)
      }
    })

    it(`recording stub: ${e.fn} passes the documented facts`, async () => {
      const row = ROWS[e.fn] as Row
      const doc = DOC[row.kind]
      expect(doc, row.kind).toBeDefined()
      const required = (doc ?? []).filter((k) => !k.endsWith("?"))
      const allowed = new Set((doc ?? []).map((k) => k.replace(/\?$/, "")))
      for (const c of e.cases) {
        // "unknown" totals are a template-only case (see the row): skip facts.
        if (JSON.stringify(c.args).includes('"unknown"')) continue
        const rec = recording(row.kind)
        await row.run(rec.text, c.args)
        expect(rec.calls.length, e.fn).toBe(1)
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
  })

  it("tool_text.Glob.missing_pattern through executeTool", async () => {
    const rec = recording("tool_text.Glob.missing_pattern")
    const r = await executeTool("Glob", {}, { text: rec.text })
    expect(r).toMatchObject({ content: "STUB tool_text.Glob.missing_pattern", is_error: true })
  })
})
