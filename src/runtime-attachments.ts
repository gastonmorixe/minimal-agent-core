/**
 * Shared runtime-attachment detection.
 *
 * The agent runtime prepends certain `<ma::agent::*>` and
 * `<ma::plugin::*>` text blocks to the user message each turn (task
 * list, scratchpad, save echoes, mode toggles, reflection checkpoints,
 * sub-agents digest, etc.). These carry model-facing context and have
 * no user-visible payload. Any code path that renders user content for
 * DISPLAY — session replay, session dump, SessionHistory previews — must
 * strip them so the TUI scrollback and tool output don't leak raw XML
 * tags.
 *
 * # Single source of truth
 *
 * This module is the canonical definition.  Both `session-replay.ts`
 * (the `--resume` path) and `sessions-read.ts` (the `SessionHistory`
 * tool path) import from here.  When a new attachment type is added in
 * `agent.ts`, the corresponding opener regex must be added here so
 * every display path picks it up.
 *
 * # Matching discipline
 *
 * Each attachment is pushed as its OWN dedicated `ContentBlock`
 * (`agent.ts` guarantees this).  Therefore a starts-with check on the
 * trimmed block text is sufficient — we never need to validate the
 * closing tag.  The one false-positive scenario is a user who pastes
 * one of these openers as the first non-whitespace of their own prompt,
 * which is acceptable (the tag belongs to the agent runtime by
 * convention).
 *
 * @module runtime-attachments
 */

import type { ContentBlock } from "./llm/messages.ts"

/**
 * Regex list matching the opening-tag prefix of every text block the
 * agent runtime may prepend to a user message.  Order doesn't matter;
 * the test is "does ANY pattern match the start of the block?"
 */
export const RUNTIME_ATTACHMENT_OPENERS: readonly RegExp[] = [
  // New schema (canonical): every agent/plugin attachment opens with
  // `<ma::agent::*>` or `<ma::plugin::*>`. One regex covers them all.
  /^\s*<ma::(?:agent|plugin|plugins)::/i,

  // Bare `<ma::plugins>` system-prompt wrapper (also a legitimate
  // top-level emission, though it doesn't ride per-turn attachments).
  /^\s*<ma::plugins\b/,

  // Legacy forms accepted during the migration window so sessions
  // started before the `<ma::agent::*>` schema refactor still display
  // cleanly.  Drop these once older session files are no longer in
  // circulation.
  /^\s*<(?:ma::)?mode-change\b/,
  /^\s*<ma::(?:mode-active|reflection-checkpoint|reflection-ack|emergency-cap-triggered|tui-preview|tui::[a-z][a-z0-9_-]*)\b/i,
  /^\s*<short-term-memory\b/,
  /^\s*<memory-saved\b/,
]

/**
 * True iff `b` is a text content block the agent runtime prepended to
 * a user message.  These have no user-visible payload and must be
 * skipped when rendering for display.
 */
export function isRuntimeAttachmentBlock(b: ContentBlock): boolean {
  if (b.type !== "text") return false
  return isRuntimeAttachmentText(b.text)
}

/**
 * True iff `text` starts with one of the known runtime-attachment
 * opener tags.  Call this from string-level pipelines (e.g.
 * `blocksToText`) that don't have a full `ContentBlock` to inspect.
 */
export function isRuntimeAttachmentText(text: string): boolean {
  return RUNTIME_ATTACHMENT_OPENERS.some((re) => re.test(text))
}
