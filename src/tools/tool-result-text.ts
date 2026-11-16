/**
 * Built-in tool result texts through the G3 synthetic text resolver
 * (core-prompts decouple P1.3). Each function asks the resolver for one
 * kind with data-only facts, and passes the old PROMPTS.ts text as the
 * fallback, so the bytes stay equal when no provider owns the kind.
 *
 * `text` is optional everywhere. Omitted: no provider, the fallback text.
 *
 * @module tools/tool-result-text
 */

import type { SyntheticFacts, SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"
import { FALLBACK_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"

import * as P from "./PROMPTS.ts"

type Text = SyntheticTextResolver | undefined

function say(text: Text, kind: SyntheticKind, facts: SyntheticFacts, old: () => string): string {
  return (text ?? FALLBACK_SYNTHETIC_TEXT).resolve(kind, facts, old)
}

/** The message of a thrown value, for a `detail` fact. */
export function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** `tool_result.aborted` with `site: "runtime"`. */
export function abortedText(text: Text): string {
  return say(text, "tool_result.aborted", { site: "runtime" }, () => P.toolAbortedByUserResult())
}

/** `tool_result.unknown_tool`. */
export function unknownToolText(text: Text, name: string): string {
  return say(text, "tool_result.unknown_tool", { name }, () => P.unknownToolResult(name))
}

/** `tool_result.no_executor` for the `Mode` tool. */
export function modeNoExecutorText(text: Text): string {
  return say(text, "tool_result.no_executor", { name: "Mode" }, () =>
    P.modeToolDispatcherBugResult(),
  )
}

/** `runtime.reflection_ack_result`. */
export function reflectionAckText(text: Text): string {
  return say(text, "runtime.reflection_ack_result", {}, () => P.reflectionAckToolResult())
}

/** `tool_text.Bash.cd_no_dir`. */
export function bashCdNoDirText(text: Text, path: string): string {
  return say(text, "tool_text.Bash.cd_no_dir", { path }, () => P.cdNoSuchDirectoryResult(path))
}

/** `tool_text.Bash.output_cap`. */
export function bashOutputCapText(text: Text, maxBytes: number): string {
  return say(text, "tool_text.Bash.output_cap", { maxBytes }, () => P.bashOutputCapMarker(maxBytes))
}

/** `tool_text.Bash.timed_out`. */
export function bashTimedOutText(text: Text, timeoutMs: number): string {
  return say(text, "tool_text.Bash.timed_out", { timeoutMs }, () => P.bashTimedOutMarker(timeoutMs))
}

/** `tool_text.Bash.exit_code`. A null code has no `exitCode` fact. */
export function bashExitCodeText(text: Text, exitCode: number | null): string {
  const facts: SyntheticFacts = exitCode === null ? {} : { exitCode }
  return say(text, "tool_text.Bash.exit_code", facts, () => P.bashExitCodeResult(exitCode))
}

/** `tool_text.Bash.error`. */
export function bashErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Bash.error", { detail }, () => P.bashErrorResult(detail))
}

/** `tool_text.Read.whitespace_resolved`. */
export function readWhitespaceText(text: Text, path: string): string {
  return say(text, "tool_text.Read.whitespace_resolved", { path }, () =>
    P.whitespaceResolvedNote(path),
  )
}

/** `tool_text.Read.too_large`. */
export function readTooLargeText(text: Text, sizeMb: string, limitMb: number): string {
  return say(text, "tool_text.Read.too_large", { sizeMb, limitMb }, () =>
    P.readTooLargeResult(sizeMb, limitMb),
  )
}

/** `tool_text.Read.error`. */
export function readErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Read.error", { detail }, () => P.readErrorResult(detail))
}

/** `tool_text.Write.written`. */
export function writeWrittenText(text: Text, path: string): string {
  return say(text, "tool_text.Write.written", { path }, () => P.fileWrittenResult(path))
}

/** `tool_text.Write.error`. */
export function writeErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Write.error", { detail }, () => P.writeErrorResult(detail))
}

/** `tool_text.Edit.not_found`. */
export function editNotFoundText(text: Text, path: string): string {
  return say(text, "tool_text.Edit.not_found", { path }, () => P.editOldStringNotFoundResult(path))
}

/** `tool_text.Edit.multiple`. */
export function editMultipleText(text: Text, count: number, path: string): string {
  return say(text, "tool_text.Edit.multiple", { count, path }, () =>
    P.editOldStringMultipleMatchesResult(count, path),
  )
}

/** `tool_text.Edit.edited`. */
export function editEditedText(text: Text, path: string, replacements: number): string {
  return say(text, "tool_text.Edit.edited", { path, replacements }, () =>
    P.fileEditedResult(path, replacements),
  )
}

/** `tool_text.Edit.error`. */
export function editErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Edit.error", { detail }, () => P.editErrorResult(detail))
}

/** `tool_text.Glob.timeout`. */
export function globTimeoutText(text: Text, ms: number, skippedDirs: number): string {
  return say(text, "tool_text.Glob.timeout", { ms, skippedDirs }, () =>
    P.globTimeoutNotice(ms, skippedDirs),
  )
}

/** `tool_text.Glob.skipped_dirs`. */
export function globSkippedDirsText(text: Text, count: number): string {
  return say(text, "tool_text.Glob.skipped_dirs", { count }, () => P.globSkippedDirsNotice(count))
}

/** `tool_text.Glob.no_files`. */
export function globNoFilesText(text: Text): string {
  return say(text, "tool_text.Glob.no_files", {}, () => P.noFilesMatchedResult())
}

/** `tool_text.Glob.error`. */
export function globErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Glob.error", { detail }, () => P.globErrorResult(detail))
}

/** `tool_text.Grep.error`. */
export function grepErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Grep.error", { detail }, () => P.grepErrorResult(detail))
}

/** `tool_text.Grep.no_matches`. */
export function grepNoMatchesText(text: Text): string {
  return say(text, "tool_text.Grep.no_matches", {}, () => P.noMatchesFoundResult())
}

/** `tool_text.Write.arg_not_string`. */
export function writeArgNotStringText(text: Text, key: string, got: string): string {
  return say(text, "tool_text.Write.arg_not_string", { key, got }, () =>
    P.writeArgNotStringResult(key, got),
  )
}

/** `tool_text.Write.missing_path`. */
export function writeMissingPathText(text: Text): string {
  return say(text, "tool_text.Write.missing_path", {}, () => P.writeMissingPathResult())
}

/** `tool_text.Write.missing_content`. */
export function writeMissingContentText(text: Text): string {
  return say(text, "tool_text.Write.missing_content", {}, () => P.writeMissingContentResult())
}

/** `tool_text.Glob.missing_pattern`. */
export function globMissingPatternText(text: Text): string {
  return say(text, "tool_text.Glob.missing_pattern", {}, () => P.globMissingPatternResult())
}

/** `tool_text.Glob.arg_not_string`. */
export function globArgNotStringText(text: Text, key: string, got: string): string {
  return say(text, "tool_text.Glob.arg_not_string", { key, got }, () =>
    P.globArgNotStringResult(key, got),
  )
}

/** `tool_result.lock_timeout`. */
export function lockTimeoutText(text: Text, tool: string, detail: string): string {
  return say(text, "tool_result.lock_timeout", { tool, detail }, () =>
    P.lockTimeoutResult(tool, detail),
  )
}

/** `tool_result.lock_failed`. */
export function lockFailedText(text: Text, tool: string, detail: string): string {
  return say(text, "tool_result.lock_failed", { tool, detail }, () =>
    P.lockAcquireFailedResult(tool, detail),
  )
}

/** Facts of `tool_output.truncated`. Data only: the hint is the provider's text. */
export interface TruncatedFacts {
  /** Tool name, "" when unknown. Selects the per-tool hint. */
  readonly tool: string
  readonly shownBytes: number
  readonly totalBytes: number
  readonly shownLines: number
  readonly totalLines: number
  readonly cutLine: number
  readonly maxToolOutputBytes: number
}

/**
 * `tool_output.truncated`: the bracketed notice with its per-tool hint. The
 * caller keeps the body and the blank-line join, so the provider never sees tool
 * output. The fallback computes the old hint and renders the old notice with
 * an empty body, then drops the join, byte equal.
 */
export function truncatedNoticeText(text: Text, facts: TruncatedFacts): string {
  return say(text, "tool_output.truncated", { ...facts }, () =>
    P.truncatedOutputNotice({
      kept: "",
      shownBytes: facts.shownBytes,
      totalBytes: String(facts.totalBytes),
      shownLines: facts.shownLines,
      totalLines: String(facts.totalLines),
      cutLine: facts.cutLine,
      hint: P.truncationHint(
        facts.tool === "" ? undefined : facts.tool,
        facts.cutLine,
        facts.maxToolOutputBytes,
      ),
    }).slice(2),
  )
}

/**
 * `tool_output.preview`: the `<ma::agent::output-preview>` tag with its hint.
 * The caller keeps the body and the blank-line join. Facts are data only. The
 * fallback computes the old hint and renders the old tag, byte equal.
 */
export function previewTagText(
  text: Text,
  args: { shown: number; total: number; tool: string; rawPath?: string },
): string {
  const { shown, total, tool, rawPath } = args
  const bash = tool === "Bash"
  const facts: SyntheticFacts = rawPath
    ? { shown, total, tool, bash, rawPath }
    : { shown, total, tool, bash }
  return say(text, "tool_output.preview", facts, () => {
    const hint = P.tuiPreviewHint(tool, rawPath)
    return P.outputPreviewAnnotation({
      content: "",
      shown,
      total,
      tool,
      path: rawPath,
      hint,
    }).slice(2)
  })
}
