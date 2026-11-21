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
 * Family `runtime.*` (turn markers, attachments):
 * `runtime.turn_aborted`, `runtime.session_resumed`,
 * `runtime.stream_interrupted`: no facts.
 * `runtime.hook_denied`: `hook` (the channel, today `turn.willStop`). The
 * reason of a hook halt that gave no reason, sent in the continue note.
 *
 * Family `tool_output.*` (output caps and previews, core keeps the content):
 * `tool_output.preview`: `shown`, `total`, `tool`, `bash` (tool is Bash),
 * `rawPath?` (the raw-output blob path). The text holds the tag and its hint.
 * `tool_output.truncated`: `tool` ("" when unknown), `shownBytes`,
 * `totalBytes`, `shownLines`, `totalLines`, `cutLine`, `maxToolOutputBytes`.
 * Optional facts (only core with the M3c facts sets them; a provider can
 * ignore them, and an old core does not send them): `cutMidLine` (boolean, a
 * shown line is not complete), `longLines` (number, lines that the per-line
 * clamp cut), `lineCharCap` (number, the per-line cap in UTF-16 units),
 * `lastLinePartial` (boolean, the byte cut ended inside a line), `nextOffset`
 * (number, the zero-based line where a next read can start), `totalLinesKnown`
 * (boolean, false when core measured the total lines itself).
 * The text holds the bracketed notice and its per-tool hint.
 * `tool_output.streak`: `tool`, `threshold`.
 * `tool_output.binary_withheld`: `optedIn` (the call set `binary: true` but
 * the body is too large to inline), `hasPath` (a blob path is in the tag).
 * The prose after the `<ma::agent::binary-result />` tag. Core keeps the tag.
 *
 * Family `tool_result.*` (a tool result that core makes):
 * `tool_result.aborted`: `site` (`runtime` or `orphan`).
 * `tool_result.interrupted_by_stop`: no facts.
 * `tool_result.unknown_tool`: `name`, `plugin?` (a plugin tool name).
 * `tool_result.handler_error`: `detail`.
 * `tool_result.non_tool_result`: `tool` (a plugin tool that returned a
 * value that is not a tool_result).
 * `tool_result.invalid_input`: `tool` (a built-in tool), `count` (the
 * number of schema errors), and per error `i` (0-based): `path.i` (`""` is
 * the root), `rule.i` (`enum` | `type` | `required` | `additional`),
 * `key.i` (required, additional), `expected.i` (type tokens joined with
 * `,`) and `got.i` (type).
 * `tool_result.policy_denied`: `hook` (today `tool.willInvoke`), a halt
 * with no reason.
 * `tool_result.policy_hook_failed`: `hook`, `detail` (the error message),
 * `label?` (the failing listener label; absent when the emit itself threw).
 * `tool_result.canceled`: `site` (today `subprocess`), a plugin tool call
 * aborted before or while it ran.
 * `tool_result.no_executor`: `name`, `site`: `dispatcher` (the `Mode`
 * tool reached the built-in dispatcher) or `session` (the session has no
 * tool executor).
 * `tool_result.policy_rewrite_note`: `keys` (the shown changed input key
 * names, comma-joined, may be ""), `dropped` (count of keys not shown).
 * `tool_result.subprocess_overflow`: `maxBytes`, `detail`.
 * `tool_result.lock_timeout`, `tool_result.lock_failed`: `tool`, `detail`.
 *
 * Family `user_media.*`:
 * `user_media.rejected`: `site`, `reason`, `modelId?`, `kind?`, `mimeType?`,
 * `sizeBytes?`, `encodedBytes?`, `limitBytes?`, `width?`, `height?`,
 * `maxDimension?`, `maxItems?`. `site` is `check` (the bare reason: the
 * attach warning, the paste diagnostic, the base of the marker) or `marker`
 * (the whole `[<kind> not sent: ...]` marker in the user turn). `reason` is
 * the rejection code: `unsupported-modality`, `unsupported-type`,
 * `too-large`, `dimensions`, `too-many`, `request-too-large`. `modelId` is
 * absent when the caller knows no model. `kind` and `mimeType` are set for a
 * per-item check and for every marker. Sizes are bytes (`encodedBytes` is
 * the base64 size, `limitBytes` the per-item or request cap).
 * `user_media.unavailable`: `id` (the attachment id of a stale token).
 *
 * Family `tool_text.<Tool>.*` (results of the built-in tools):
 * `tool_text.Bash.cd_no_dir`: `path`. `tool_text.Bash.output_cap`:
 * `maxBytes`. `tool_text.Bash.timed_out`: `timeoutMs`, `clamped?` (true
 * when the limit is the maximum, not the larger value of the input).
 * `tool_text.Bash.exit_code`: `exitCode?` (absent for a null code).
 * `tool_text.Bash.error`: `detail`. `tool_text.Bash.aborted`: no facts.
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
 * `tool_text.Write.not_read`, `tool_text.Edit.not_read`: `path` (a file
 * not read in this session). `tool_text.Write.stale`,
 * `tool_text.Edit.stale`: `path`, `status` (`missing` or `changed`).
 * `tool_text.Edit.not_found`: `path`. `tool_text.Edit.multiple`: `count`,
 * `path`. `tool_text.Edit.edited`: `path`, `replacements`.
 * `tool_text.Edit.error`: `detail`.
 * `tool_text.Glob.no_files`, `tool_text.Glob.missing_pattern`: no facts.
 * `tool_text.Glob.arg_not_string`: `key`, `got`. `tool_text.Glob.error`:
 * `detail`. `tool_text.Glob.timeout`: `ms`, `skippedDirs`.
 * `tool_text.Glob.skipped_dirs`: `count`.
 * `tool_text.Grep.error`: `detail`. `tool_text.Grep.no_matches`: no facts.
 * `tool_text.Grep.timed_out`: `ms`, `engine` (`rg` or `js`).
 * `tool_text.Grep.exit_code`: `exitCode` (rg failed with no output).
 * `tool_text.FilesStats.empty`: `filtered` (a status or path filter was
 * set). The lines before the totals line of an empty report.
 * `tool_text.FilesStats.not_enabled`: no facts (no file tracking).
 *
 * Family `mode.*` (mode stamps and refusals):
 * `mode.refusal`: `tool`, `modeId`, `label`, `hint?`.
 * `mode.active_stamp`: `id`, `since`. `mode.change`: `from`, `to`, `at`.
 * `mode.cli_refusal`: `tool`, `reason` (`deny-all` or `allow-list`), the
 * host tool name gate (`--no-tools`, `--tools`).
 *
 * Family `compact.*` (context compaction):
 * `compact.summary_system`: `focus?` (trimmed, non-empty). The system prompt
 * of the summary request (local and remote).
 * `compact.tail_checkpoint`: `retained` (count of messages kept verbatim).
 * `compact.local_checkpoint`: `focus?` (trimmed, non-empty), `summary?` (the
 * trimmed model summary, data; absent means the stub checkpoint).
 * Both checkpoint texts are the prose after the
 * `<ma::context::compaction kind="..." />` tag line. Core keeps the tag.
 *
 * @module types/synthetic-text
 */

import type { PromptTemplateText } from "./plugin.ts"
import type { SidebandApi } from "./sideband.ts"

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
  "runtime.hook_denied",
  "tool_output.preview",
  "tool_output.truncated",
  "tool_output.streak",
  "tool_output.binary_withheld",
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
  "tool_result.policy_rewrite_note",
  "user_media.rejected",
  "user_media.unavailable",
  "tool_text.Bash.cd_no_dir",
  "tool_text.Bash.output_cap",
  "tool_text.Bash.timed_out",
  "tool_text.Bash.exit_code",
  "tool_text.Bash.error",
  "tool_text.Bash.aborted",
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
  "tool_text.Write.not_read",
  "tool_text.Write.stale",
  "tool_text.Edit.not_found",
  "tool_text.Edit.multiple",
  "tool_text.Edit.edited",
  "tool_text.Edit.error",
  "tool_text.Edit.not_read",
  "tool_text.Edit.stale",
  "tool_text.Glob.no_files",
  "tool_text.Glob.missing_pattern",
  "tool_text.Glob.arg_not_string",
  "tool_text.Glob.error",
  "tool_text.Glob.timeout",
  "tool_text.Glob.skipped_dirs",
  "tool_text.Grep.error",
  "tool_text.Grep.no_matches",
  "tool_text.Grep.timed_out",
  "tool_text.Grep.exit_code",
  "tool_text.FilesStats.empty",
  "tool_text.FilesStats.not_enabled",
  "mode.refusal",
  "mode.active_stamp",
  "mode.change",
  "mode.cli_refusal",
  "compact.summary_system",
  "compact.tail_checkpoint",
  "compact.local_checkpoint",
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

/**
 * Supplies text for the kinds it lists. It MUST NOT return "" (R-API-4.2).
 *
 * `T` is the return type of `text`. Default: `string` (data: core sends it
 * unchanged). A provider typed `SyntheticTextProvider<string | PromptTemplateText>`
 * can return a {@link PromptTemplateText}: core renders it with its `vars`.
 */
export interface SyntheticTextProvider<T extends string | PromptTemplateText = string> {
  readonly kinds: readonly SyntheticKind[]
  /**
   * The text of `kind`. `sb` is the sideband API of the session (design
   * D8): core always passes it (`ready` is false with no codec). A provider
   * with two parameters stays valid.
   */
  text(kind: SyntheticKind, facts: SyntheticFacts, sb?: SidebandApi): T
}

/** A provider that can return a string or a {@link PromptTemplateText}. Core accepts it. */
export type AnySyntheticTextProvider = SyntheticTextProvider<string | PromptTemplateText>
