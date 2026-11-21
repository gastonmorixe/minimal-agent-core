/**
 * The one wrap for hook context strings that reach the model.
 *
 * Hook listeners can return `additionalContext` (tool channels,
 * `turn.willStart`, `turn.willStop`, `session.willStart`). Every site that
 * puts those strings in front of the model wraps them here, so the model
 * sees one stable shape.
 *
 * An entry is a string, or `{ text, position }`. The position counts only on
 * `turn.willStart` and `session.willStart` (see {@link splitHookContext}).
 * Every other channel uses the entry text and ignores the position.
 *
 * @module sdk/hook-context
 */

import type { HookContextEntry } from "../../plugin-api/src/types/hook-context.ts"
import { renderCoreBody } from "../sideband/core-render.ts"
import type { SidebandApi } from "../sideband/types.ts"

/**
 * One hook context entry (defined in plugin-api, the one source of truth).
 * A string means `"after"`. An object without a `position` also means
 * `"after"`. `"before"` puts the text before the user prompt in the first
 * user message of a turn.
 */
export type { HookContextEntry }

/** True when `x` is a well-formed {@link HookContextEntry}. */
export function isHookContextEntry(x: unknown): x is HookContextEntry {
  if (typeof x === "string") return true
  if (typeof x !== "object" || x === null) return false
  const o = x as { text?: unknown; position?: unknown }
  if (typeof o.text !== "string") return false
  return o.position === undefined || o.position === "before" || o.position === "after"
}

/** The text of an entry, or `null` when it is not a well-formed entry. */
function entryText(x: unknown): string | null {
  if (!isHookContextEntry(x)) return null
  return typeof x === "string" ? x : x.text
}

/** Keep the non-blank texts of a context list (strings or entries). */
export function cleanHookContext(lines: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(lines)) return []
  const out: string[] = []
  for (const x of lines) {
    const text = entryText(x)
    if (text !== null && text.trim().length > 0) out.push(text)
  }
  return out
}

/**
 * The sideband kind of hook context text: each line is one `policy` tag
 * ({@link wrapHookContext}). It is also the block mark of a hook context
 * block (design step 12c).
 */
export const HOOK_CONTEXT_KIND = "policy"

/**
 * One text block of wrapped hook context, with the block mark
 * `sideband: { kind: "policy" }` (design step 12c). A block can hold more
 * than one `policy` line: all have the same kind, so the mark is the kind of
 * the first tag. With no codec the text is the lines with no wrapper; the
 * block still gets the mark (it is harness text). The mark is metadata only:
 * no encoder sends it.
 */
export function hookContextBlock(text: string): {
  type: "text"
  text: string
  sideband: { kind: string }
} {
  return { type: "text", text, sideband: { kind: HOOK_CONTEXT_KIND } }
}

/**
 * Wrap each context line in one `policy` tag, one per line. `sb.render`
 * makes the bytes (design step 6). Returns `""` when no line is left after
 * {@link cleanHookContext}. With no codec, or no `policy` kind, each line
 * is its text with no wrapper ({@link renderCoreBody}), so the plugin
 * context still reaches the model.
 */
export function wrapHookContext(
  sb: Pick<SidebandApi, "render">,
  lines: readonly unknown[] | undefined,
): string {
  return cleanHookContext(lines)
    .map((n) => renderCoreBody(sb, HOOK_CONTEXT_KIND, { body: n }))
    .join("\n")
}

/**
 * Split entries by position. A string, or an object with no `position`,
 * goes to `after`. Blank and malformed entries are dropped. Order is kept.
 */
export function splitHookContext(entries: readonly unknown[] | undefined): {
  before: string[]
  after: string[]
} {
  const before: string[] = []
  const after: string[] = []
  if (!Array.isArray(entries)) return { before, after }
  for (const x of entries) {
    if (!isHookContextEntry(x)) continue
    const text = typeof x === "string" ? x : x.text
    if (text.trim().length === 0) continue
    if (typeof x !== "string" && x.position === "before") before.push(text)
    else after.push(text)
  }
  return { before, after }
}
