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
import type { SidebandApi, SidebandReader } from "../sideband/types.ts"

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
  sb: AttachmentReader = NO_SIDEBAND,
): boolean {
  if (b.type !== "text") return false
  if (b.sideband !== undefined) return true
  return isRuntimeAttachmentText(b.text, sb)
}

/**
 * The reader of {@link isRuntimeAttachmentText}. `name` and `kinds` are
 * optional: the full {@link SidebandApi} has them, and with them an old tag
 * of a kind that no plugin registers now still counts (see the function).
 */
export type AttachmentReader = SidebandReader & Partial<Pick<SidebandApi, "name" | "kinds">>

/**
 * True iff the first non-space content of `text` is the start of a sideband
 * tag that the harness writes, and not a from-model tag. The codec reads the
 * node at the start of the text (`leadingKind`, a start part with no end part
 * counts). It counts when:
 *
 * 1. its kind is registered and is not `from-model` (each codec form: v1, v2,
 *    the old bare names, upper case); or
 * 2. its kind is not registered (an old kind, for example from an old session
 *    file), the node is complete, and the codec name of the node is the name
 *    that the codec gives a registered `to-model` `turn` kind (the harness
 *    attachments) with the kind part changed: the same name level. The codec
 *    gives each name (`legacyQname`, `name`), so core holds no tag text.
 *
 * An unregistered name of an other level (a from-model name, a v2 name, a
 * name with no level) is user text: it shows.
 *
 * Call this from string-level pipelines (e.g. `blocksToText`) that don't
 * have a full `ContentBlock` to inspect.
 *
 * @param text - The block text.
 * @param sb - The sideband reader. With `NO_SIDEBAND` (the default, no
 *   codec) the result is always false: no text is hidden. Without `name`
 *   and `kinds`, rule 2 does not apply.
 */
export function isRuntimeAttachmentText(text: string, sb: AttachmentReader = NO_SIDEBAND): boolean {
  const kind = sb.leadingKind(text)
  if (kind === undefined) return false
  const info = sb.kindInfo(kind)
  if (info !== undefined) return info.direction !== "from-model"
  return harnessLevelName(text, kind, sb)
}

/** Rule 2 of {@link isRuntimeAttachmentText}: an unregistered kind at a harness name level. */
function harnessLevelName(text: string, kind: string, sb: AttachmentReader): boolean {
  if (sb.name === undefined || sb.kinds === undefined) return false
  const at = text.length - text.trimStart().length
  const node = sb.find(text).find((n) => n.span.start === at && n.kind === kind)
  const qname = node?.legacyQname?.toLowerCase()
  if (qname === undefined || !qname.endsWith(kind)) return false
  const level = qname.slice(0, qname.length - kind.length)
  if (level === "") return false
  for (const k of sb.kinds({ direction: "to-model", placement: "turn" })) {
    const name = sb.name(k.kind).toLowerCase()
    if (name.endsWith(k.kind) && name.slice(0, name.length - k.kind.length) === level) return true
  }
  return false
}
