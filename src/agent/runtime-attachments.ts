/**
 * Shared runtime-attachment detection.
 *
 * The agent runtime prepends certain `<ma::agent::*>` and
 * `<ma::plugin::*>` text blocks to the user message each turn (task
 * list, scratchpad, save echoes, mode toggles, sub-agents digest,
 * etc.). These carry model-facing context and have
 * no user-visible payload. Any code path that renders user content for
 * DISPLAY — session replay, session dump, SessionHistory previews — must
 * strip them so the TUI scrollback and tool output don't leak raw XML
 * tags.
 *
 * # Single source of truth
 *
 * This module is the canonical definition.  Both `session-replay.ts`
 * (the `--resume` path) and `sessions-read.ts` (the `SessionHistory`
 * tool path) import from here.  The sideband codec owns the tag forms
 * (design step 8): a new attachment kind needs no change here.
 *
 * # Matching discipline
 *
 * Each attachment is pushed as its OWN dedicated `ContentBlock`
 * (`AgentCore` guarantees this).  Therefore a starts-with check on the
 * trimmed block text is sufficient — we never need to validate the
 * closing tag.  The one false-positive scenario is a user who pastes
 * one of these openers as the first non-whitespace of their own prompt,
 * which is acceptable (the tag belongs to the agent runtime by
 * convention).
 *
 * @module runtime-attachments
 */

import type { ContentBlock } from "../llm/messages.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import type { SidebandReader } from "../sideband/types.ts"

/**
 * True iff `b` is a text content block the agent runtime prepended to
 * a user message.  These have no user-visible payload and must be
 * skipped when rendering for display.
 *
 * A block with a `sideband` mark is an attachment (cheap and exact). Else
 * the text test of {@link isRuntimeAttachmentText} runs (old history has no
 * mark).
 *
 * @param b - The content block.
 * @param sb - The sideband reader (`sidebandOf(loader)`, or
 *   `loadSidebandOnly()` before plugin boot). With `NO_SIDEBAND` (the
 *   default) only a marked block is an attachment: an unmarked one shows.
 */
export function isRuntimeAttachmentBlock(
  b: ContentBlock,
  sb: SidebandReader = NO_SIDEBAND,
): boolean {
  if (b.type !== "text") return false
  if (b.sideband !== undefined) return true
  return isRuntimeAttachmentText(b.text, sb)
}

/**
 * True iff the first non-space content of `text` is the start of a sideband
 * tag that the harness writes (each codec form: v1, v2 and the old bare
 * names), and not a from-model tag (`emit` level). The codec reads the node
 * at the start of the text (`leadingKind`); a kind that is not registered
 * counts as a harness tag. A start
 * part with no end part counts. Call this from string-level pipelines (e.g.
 * `blocksToText`) that don't have a full `ContentBlock` to inspect.
 *
 * @param text - The block text.
 * @param sb - The sideband reader. With `NO_SIDEBAND` (the default, no
 *   codec) the result is always false: no text is hidden.
 */
export function isRuntimeAttachmentText(text: string, sb: SidebandReader = NO_SIDEBAND): boolean {
  const kind = sb.leadingKind(text)
  return kind !== undefined && sb.kindInfo(kind)?.direction !== "from-model"
}
