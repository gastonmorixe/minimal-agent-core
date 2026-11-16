/**
 * Synthetic text provider contract (G3, R-API-4).
 *
 * A plugin that owns a {@link SyntheticKind} supplies the text core sends in
 * place of a model or user turn (a continue nudge, a placeholder, a tool
 * error result). Core holds no such text. Each kind has at most one provider.
 *
 * Facts per kind (data only, R-API-4.4). `?` marks an optional fact. A kind
 * with no list gets no facts. A `detail` fact carries the raw error message
 * of the old core function, kept for byte parity until spec Phase 11.
 *
 * Family `continue.*` (a nudge after a cut turn):
 * `continue.max_tokens`, `continue.stream_interrupted`: no facts.
 *
 * Family `assistant.*`: `assistant.placeholder`: no facts.
 *
 * Family `runtime.*` (turn markers, attachments, reflection):
 * `runtime.turn_aborted`, `runtime.session_resumed`,
 * `runtime.stream_interrupted`, `runtime.reflection_ack_result`: no facts.
 * `runtime.reflection_checkpoint`: `round`, `cooldownSec`.
 *
 * Family `tool_output.*` (output caps and previews, core keeps the content):
 * `tool_output.preview`: `shown`, `total`, `tool`, `bash` (tool is Bash),
 * `rawPath?` (the raw-output blob path). The text holds the tag and its hint.
 * `tool_output.truncated`: `tool` ("" when unknown), `shownBytes`,
 * `totalBytes`, `shownLines`, `totalLines`, `cutLine`, `maxToolOutputBytes`.
 * The text holds the bracketed notice and its per-tool hint.
 * `tool_output.streak`: `tool`, `threshold`.
 *
 * Family `tool_result.*` (a tool result that core makes):
 * `tool_result.aborted`: `site` (`runtime` or `orphan`).
 * `tool_result.interrupted_by_stop`: no facts.
 * `tool_result.unknown_tool`: `name`, `plugin?` (a plugin tool name).
 * `tool_result.handler_error`: `detail`.
 * `tool_result.non_tool_result`, `tool_result.invalid_input`,
 * `tool_result.policy_denied`, `tool_result.policy_hook_failed`,
 * `tool_result.canceled`: facts of the call site.
 * `tool_result.no_executor`: `name`.
 * `tool_result.subprocess_overflow`: `maxBytes`, `detail`.
 * `tool_result.lock_timeout`, `tool_result.lock_failed`: `tool`, `detail`.
 *
 * Family `user_media.*`:
 * `user_media.rejected`: `reason`, `modelId`, `mimeType?`, `kind?`,
 * `sizeBytes?`, `limitBytes?`, `width?`, `height?`, `maxItems?`.
 * `user_media.unavailable`: facts of the call site.
 *
 * Family `tool_text.<Tool>.*` (results of the built-in tools):
 * `tool_text.Bash.cd_no_dir`: `path`. `tool_text.Bash.output_cap`:
 * `maxBytes`. `tool_text.Bash.timed_out`: `timeoutMs`.
 * `tool_text.Bash.exit_code`: `exitCode?` (absent for a null code).
 * `tool_text.Bash.error`: `detail`.
 * `tool_text.Read.whitespace_resolved`: `path`. `tool_text.Read.too_large`:
 * `sizeMb`, `limitMb`. `tool_text.Read.error`: `detail`.
 * `tool_text.Read.binary_rejected`, `tool_text.Read.unsupported_embedding`:
 * `mimeType`, `sizeBytes`. `tool_text.Read.unsupported_image_modality`:
 * `modelId`, `mimeType`, `sizeBytes`. `tool_text.Read.image_too_large`:
 * `sizeBytes`, `limitBytes`, `modelId`. `tool_text.Read.image_summary`:
 * `subtype`, `sizeBytes`, `width?`, `height?`, `fittedStrategy?`.
 * `tool_text.Write.written`: `path`. `tool_text.Write.error`: `detail`.
 * `tool_text.Write.missing_path`, `tool_text.Write.missing_content`: no
 * facts. `tool_text.Write.arg_not_string`: `key`, `got`.
 * `tool_text.Edit.not_found`: `path`. `tool_text.Edit.multiple`: `count`,
 * `path`. `tool_text.Edit.edited`: `path`, `replacements`.
 * `tool_text.Edit.error`: `detail`.
 * `tool_text.Glob.no_files`, `tool_text.Glob.missing_pattern`: no facts.
 * `tool_text.Glob.arg_not_string`: `key`, `got`. `tool_text.Glob.error`:
 * `detail`. `tool_text.Glob.timeout`: `ms`, `skippedDirs`.
 * `tool_text.Glob.skipped_dirs`: `count`.
 * `tool_text.Grep.error`: `detail`. `tool_text.Grep.no_matches`: no facts.
 *
 * Family `mode.*` (mode stamps and refusals):
 * `mode.refusal`: `tool`, `modeId`, `label`, `hint?`.
 * `mode.active_stamp`: `id`, `since`. `mode.change`: `from`, `to`, `at`.
 *
 * @module types/synthetic-text
 */

/**
 * Every synthetic text slot core can ask a provider to fill, as data. The
 * manifest check reads this list. {@link SyntheticKind} derives from it.
 */
export const SYNTHETIC_KINDS = [
  "continue.max_tokens",
  "continue.stream_interrupted",
  "assistant.placeholder",
  "runtime.turn_aborted",
  "runtime.session_resumed",
  "runtime.stream_interrupted",
  "runtime.reflection_checkpoint",
  "runtime.reflection_ack_result",
  "tool_output.preview",
  "tool_output.truncated",
  "tool_output.streak",
  "tool_result.aborted",
  "tool_result.interrupted_by_stop",
  "tool_result.unknown_tool",
  "tool_result.handler_error",
  "tool_result.non_tool_result",
  "tool_result.invalid_input",
  "tool_result.policy_denied",
  "tool_result.policy_hook_failed",
  "tool_result.canceled",
  "tool_result.no_executor",
  "tool_result.subprocess_overflow",
  "tool_result.lock_timeout",
  "tool_result.lock_failed",
  "user_media.rejected",
  "user_media.unavailable",
  "tool_text.Bash.cd_no_dir",
  "tool_text.Bash.output_cap",
  "tool_text.Bash.timed_out",
  "tool_text.Bash.exit_code",
  "tool_text.Bash.error",
  "tool_text.Read.whitespace_resolved",
  "tool_text.Read.too_large",
  "tool_text.Read.error",
  "tool_text.Read.binary_rejected",
  "tool_text.Read.unsupported_embedding",
  "tool_text.Read.unsupported_image_modality",
  "tool_text.Read.image_too_large",
  "tool_text.Read.image_summary",
  "tool_text.Write.written",
  "tool_text.Write.error",
  "tool_text.Write.missing_path",
  "tool_text.Write.missing_content",
  "tool_text.Write.arg_not_string",
  "tool_text.Edit.not_found",
  "tool_text.Edit.multiple",
  "tool_text.Edit.edited",
  "tool_text.Edit.error",
  "tool_text.Glob.no_files",
  "tool_text.Glob.missing_pattern",
  "tool_text.Glob.arg_not_string",
  "tool_text.Glob.error",
  "tool_text.Glob.timeout",
  "tool_text.Glob.skipped_dirs",
  "tool_text.Grep.error",
  "tool_text.Grep.no_matches",
  "mode.refusal",
  "mode.active_stamp",
  "mode.change",
] as const

/** Every synthetic text slot core can ask a provider to fill. */
export type SyntheticKind = (typeof SYNTHETIC_KINDS)[number]

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(SYNTHETIC_KINDS)

/** Is `v` a known {@link SyntheticKind}? Pure. */
export function isSyntheticKind(v: unknown): v is SyntheticKind {
  return typeof v === "string" && KNOWN_KINDS.has(v)
}

/** Typed facts core passes to a provider. No free message text. */
export type SyntheticFacts = Readonly<Record<string, string | number | boolean>>

/** Supplies text for the kinds it lists. It MUST NOT return "" (R-API-4.2). */
export interface SyntheticTextProvider {
  readonly kinds: readonly SyntheticKind[]
  text(kind: SyntheticKind, facts: SyntheticFacts): string
}
