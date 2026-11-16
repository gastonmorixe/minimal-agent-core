/**
 * Built-in tool result texts through the G3 synthetic text resolver
 * (core-prompts decouple P1.3). Each function asks the resolver for one
 * kind with data-only facts. Core holds no text: with no provider the
 * result is "" (bare core).
 *
 * `text` is optional everywhere. Omitted: no provider, "".
 *
 * @module tools/tool-result-text
 */

import type { SyntheticFacts, SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"
import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { SchemaError } from "../sdk/output-schema.ts"

type Text = SyntheticTextResolver | undefined

function say(text: Text, kind: SyntheticKind, facts: SyntheticFacts): string {
  return (text ?? EMPTY_SYNTHETIC_TEXT).resolve(kind, facts)
}

/** The message of a thrown value, for a `detail` fact. */
export function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** `tool_result.aborted` with `site: "runtime"`. */
export function abortedText(text: Text): string {
  return say(text, "tool_result.aborted", { site: "runtime" })
}

/** `tool_result.unknown_tool`. */
export function unknownToolText(text: Text, name: string): string {
  return say(text, "tool_result.unknown_tool", { name })
}

/** `tool_result.no_executor` for the `Mode` tool (`site: "dispatcher"`). */
export function modeNoExecutorText(text: Text): string {
  return say(text, "tool_result.no_executor", { name: "Mode", site: "dispatcher" })
}

/** `runtime.reflection_ack_result`. */
export function reflectionAckText(text: Text): string {
  return say(text, "runtime.reflection_ack_result", {})
}

/** `tool_text.Bash.cd_no_dir`. */
export function bashCdNoDirText(text: Text, path: string): string {
  return say(text, "tool_text.Bash.cd_no_dir", { path })
}

/** `tool_text.Bash.output_cap`. */
export function bashOutputCapText(text: Text, maxBytes: number): string {
  return say(text, "tool_text.Bash.output_cap", { maxBytes })
}

/** `tool_text.Bash.timed_out`. */
export function bashTimedOutText(text: Text, timeoutMs: number): string {
  return say(text, "tool_text.Bash.timed_out", { timeoutMs })
}

/** `tool_text.Bash.exit_code`. A null code has no `exitCode` fact. */
export function bashExitCodeText(text: Text, exitCode: number | null): string {
  const facts: SyntheticFacts = exitCode === null ? {} : { exitCode }
  return say(text, "tool_text.Bash.exit_code", facts)
}

/** `tool_text.Bash.error`. */
export function bashErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Bash.error", { detail })
}

/** `tool_text.Read.whitespace_resolved`. */
export function readWhitespaceText(text: Text, path: string): string {
  return say(text, "tool_text.Read.whitespace_resolved", { path })
}

/** `tool_text.Read.too_large`. */
export function readTooLargeText(text: Text, sizeMb: string, limitMb: number): string {
  return say(text, "tool_text.Read.too_large", { sizeMb, limitMb })
}

/** `tool_text.Read.error`. */
export function readErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Read.error", { detail })
}

/** `tool_text.Write.written`. */
export function writeWrittenText(text: Text, path: string): string {
  return say(text, "tool_text.Write.written", { path })
}

/** `tool_text.Write.error`. */
export function writeErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Write.error", { detail })
}

/** `tool_text.Edit.not_found`. */
export function editNotFoundText(text: Text, path: string): string {
  return say(text, "tool_text.Edit.not_found", { path })
}

/** `tool_text.Edit.multiple`. */
export function editMultipleText(text: Text, count: number, path: string): string {
  return say(text, "tool_text.Edit.multiple", { count, path })
}

/** `tool_text.Edit.edited`. */
export function editEditedText(text: Text, path: string, replacements: number): string {
  return say(text, "tool_text.Edit.edited", { path, replacements })
}

/** `tool_text.Edit.error`. */
export function editErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Edit.error", { detail })
}

/** `tool_text.Glob.timeout`. */
export function globTimeoutText(text: Text, ms: number, skippedDirs: number): string {
  return say(text, "tool_text.Glob.timeout", { ms, skippedDirs })
}

/** `tool_text.Glob.skipped_dirs`. */
export function globSkippedDirsText(text: Text, count: number): string {
  return say(text, "tool_text.Glob.skipped_dirs", { count })
}

/** `tool_text.Glob.no_files`. */
export function globNoFilesText(text: Text): string {
  return say(text, "tool_text.Glob.no_files", {})
}

/** `tool_text.Glob.error`. */
export function globErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Glob.error", { detail })
}

/** `tool_text.Grep.error`. */
export function grepErrorText(text: Text, detail: string): string {
  return say(text, "tool_text.Grep.error", { detail })
}

/** `tool_text.Grep.no_matches`. */
export function grepNoMatchesText(text: Text): string {
  return say(text, "tool_text.Grep.no_matches", {})
}

/** `tool_text.Write.arg_not_string`. */
export function writeArgNotStringText(text: Text, key: string, got: string): string {
  return say(text, "tool_text.Write.arg_not_string", { key, got })
}

/** `tool_text.Write.missing_path`. */
export function writeMissingPathText(text: Text): string {
  return say(text, "tool_text.Write.missing_path", {})
}

/** `tool_text.Write.missing_content`. */
export function writeMissingContentText(text: Text): string {
  return say(text, "tool_text.Write.missing_content", {})
}

/** `tool_text.Glob.missing_pattern`. */
export function globMissingPatternText(text: Text): string {
  return say(text, "tool_text.Glob.missing_pattern", {})
}

/** `tool_text.Glob.arg_not_string`. */
export function globArgNotStringText(text: Text, key: string, got: string): string {
  return say(text, "tool_text.Glob.arg_not_string", { key, got })
}

/** `tool_result.lock_timeout`. */
export function lockTimeoutText(text: Text, tool: string, detail: string): string {
  return say(text, "tool_result.lock_timeout", { tool, detail })
}

/** `tool_result.lock_failed`. */
export function lockFailedText(text: Text, tool: string, detail: string): string {
  return say(text, "tool_result.lock_failed", { tool, detail })
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
 * output. With no provider the notice is "".
 */
export function truncatedNoticeText(text: Text, facts: TruncatedFacts): string {
  return say(text, "tool_output.truncated", { ...facts })
}

/**
 * `tool_output.preview`: the `<ma::agent::output-preview>` tag with its hint.
 * The caller keeps the body and the blank-line join. Facts are data only.
 * With no provider the tag is "".
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
  return say(text, "tool_output.preview", facts)
}

/** `tool_text.<Tool>.not_read`: Edit or Write on a file not read in this session. */
export function notReadText(text: Text, tool: "Edit" | "Write", path: string): string {
  return say(text, tool === "Edit" ? "tool_text.Edit.not_read" : "tool_text.Write.not_read", {
    path,
  })
}

/** `tool_text.<Tool>.stale`: the file is missing or changed since it was read. */
export function staleReadText(
  text: Text,
  tool: "Edit" | "Write",
  path: string,
  status: "missing" | "changed",
): string {
  return say(text, tool === "Edit" ? "tool_text.Edit.stale" : "tool_text.Write.stale", {
    path,
    status,
  })
}

/** `tool_text.FilesStats.empty`: the lines of an empty report, before the totals. */
export function filesStatsEmptyText(text: Text, filtered: boolean): string {
  return say(text, "tool_text.FilesStats.empty", { filtered })
}

/** `tool_text.FilesStats.not_enabled`: the host has no file tracking. */
export function filesStatsNotEnabledText(text: Text): string {
  return say(text, "tool_text.FilesStats.not_enabled", {})
}

/** `tool_text.Bash.aborted`: the marker after partial output of an aborted command. */
export function bashAbortedText(text: Text): string {
  return say(text, "tool_text.Bash.aborted", {})
}

/** `tool_text.Grep.timed_out`. */
export function grepTimedOutText(text: Text, ms: number, engine: "rg" | "js"): string {
  return say(text, "tool_text.Grep.timed_out", { ms, engine })
}

/** `tool_text.Grep.exit_code`: rg failed and printed nothing. */
export function grepExitCodeText(text: Text, exitCode: number): string {
  return say(text, "tool_text.Grep.exit_code", { exitCode })
}

/** `tool_output.binary_withheld`: the prose after the binary-result tag. */
export function binaryWithheldText(text: Text, optedIn: boolean, hasPath: boolean): string {
  return say(text, "tool_output.binary_withheld", { optedIn, hasPath })
}

/** `tool_result.policy_denied`: a hook halt with no reason. */
export function policyDeniedText(text: Text, hook: string): string {
  return say(text, "tool_result.policy_denied", { hook })
}

/** `tool_result.policy_hook_failed`: an approval hook threw. */
export function policyHookFailedText(
  text: Text,
  args: { hook: string; detail: string; label?: string },
): string {
  const facts: SyntheticFacts =
    args.label === undefined
      ? { hook: args.hook, detail: args.detail }
      : { hook: args.hook, detail: args.detail, label: args.label }
  return say(text, "tool_result.policy_hook_failed", facts)
}

/** `tool_result.policy_rewrite_note`: the note that a policy hook rewrote input keys. */
export function policyRewriteNoteText(text: Text, keys: string, dropped: number): string {
  return say(text, "tool_result.policy_rewrite_note", { keys, dropped })
}

/** `tool_result.non_tool_result`: a plugin tool returned a value that is not a tool_result. */
export function nonToolResultText(text: Text, tool: string): string {
  return say(text, "tool_result.non_tool_result", { tool })
}

/**
 * The flat indexed facts of schema errors (`SyntheticFacts` is flat). For
 * each error `i`: `path.i` (`""` is the root), `rule.i` (`enum`, `type`,
 * `required`, `additional`), plus `key.i` (required, additional) or
 * `expected.i` (the type tokens joined with `,`) and `got.i` (type). `count`
 * is the number of errors. Data only: the provider owns the words.
 */
export function schemaErrorFacts(errors: readonly SchemaError[]): Record<string, string | number> {
  const facts: Record<string, string | number> = { count: errors.length }
  errors.forEach((e, i) => {
    facts[`path.${i}`] = e.path
    facts[`rule.${i}`] = e.rule
    if (e.rule === "type") {
      // Safe only because each token is a PRIMITIVE_TYPES name (no ",").
      facts[`expected.${i}`] = e.expected.join(",")
      facts[`got.${i}`] = e.got
    } else if (e.rule === "required" || e.rule === "additional") {
      facts[`key.${i}`] = e.key
    }
  })
  return facts
}

/**
 * `tool_result.invalid_input`: a built-in tool input failed its schema.
 * Facts: `tool` plus the indexed schema errors ({@link schemaErrorFacts}).
 */
export function invalidInputText(text: Text, tool: string, errors: readonly SchemaError[]): string {
  return say(text, "tool_result.invalid_input", { tool, ...schemaErrorFacts(errors) })
}

/** `runtime.hook_denied`: the reason of a hook halt that gave none. */
export function hookDeniedText(text: Text, hook: string): string {
  return say(text, "runtime.hook_denied", { hook })
}
