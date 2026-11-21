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
import { getPromptExpander } from "../llm/system-prompt-base-registry.ts"
import { DEFAULT_PROMPT_EXPANDER } from "../plugins/prompt-expand.ts"
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

/**
 * The text of an entry, or `null` when it is not a well-formed entry. S7
 * (design 50 §2): a `text` is data and passes unchanged. An entry with
 * `template: true` is a prompt template: core renders it with its `vars`
 * through the expander of the current load (else the core default).
 */
function entryText(x: unknown): string | null {
  if (!isHookContextEntry(x)) return null
  if (typeof x === "string") return x
  if (x.template !== true) return x.text
  const expand = getPromptExpander() ?? DEFAULT_PROMPT_EXPANDER
  return expand(
    { template: x.text, ...(x.vars !== undefined ? { vars: x.vars } : {}) },
    { source: `hook:${entryOrigin(x) ?? ""}` },
  )
}

/**
 * The debug origin of an entry, or undefined. Only an object entry can carry
 * one: a plain string has none.
 */
function entryOrigin(x: unknown): string | undefined {
  if (typeof x !== "object" || x === null) return undefined
  const o = x as { origin?: unknown }
  return typeof o.origin === "string" && o.origin.length > 0 ? o.origin : undefined
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
 * The non-blank entries of a context list in their original order, each with
 * its debug origin. Same drop rules as {@link cleanHookContext}, so a
 * non-position channel keeps its order.
 */
export function placedHookContext(entries: readonly unknown[] | undefined): PlacedHookContext[] {
  if (!Array.isArray(entries)) return []
  const out: PlacedHookContext[] = []
  for (const x of entries) {
    const text = entryText(x)
    if (text === null || text.trim().length === 0) continue
    const origin = entryOrigin(x)
    out.push(origin === undefined ? { text } : { text, origin })
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
 * `sideband: { kind: "policy", origin? }` (design step 12c). A block can hold
 * more than one `policy` line: all have the same kind, so the mark is the
 * kind of the first tag. With no codec the text is the lines with no wrapper;
 * the block still gets the mark (it is harness text). The mark is metadata
 * only: no encoder sends it. `origin` is a debug label for the writer.
 */
export function hookContextBlock(
  text: string,
  origin?: string,
): {
  type: "text"
  text: string
  sideband: { kind: string; origin?: string }
} {
  return {
    type: "text",
    text,
    sideband:
      origin === undefined ? { kind: HOOK_CONTEXT_KIND } : { kind: HOOK_CONTEXT_KIND, origin },
  }
}

/**
 * The one debug origin label of a group of context entries: their unique
 * origins in order, joined with `", "`. Undefined when none has one, so a
 * block of one hook shows one label and a block of two hooks shows both.
 */
export function groupOrigin(placed: readonly PlacedHookContext[]): string | undefined {
  const seen: string[] = []
  for (const p of placed) {
    if (p.origin !== undefined && !seen.includes(p.origin)) seen.push(p.origin)
  }
  return seen.length === 0 ? undefined : seen.join(", ")
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
 * One hook context text with its debug origin, as `splitHookContext` groups
 * it. The origin is undefined when the entry had none.
 */
export interface PlacedHookContext {
  readonly text: string
  readonly origin?: string
}

/**
 * Split entries by position, and keep each origin. Same rules as
 * {@link splitHookContext}: a string, or an object with no `position`, goes
 * to `after`. Blank and malformed entries are dropped. Order is kept.
 */
export function splitHookContextPlaced(entries: readonly unknown[] | undefined): {
  before: PlacedHookContext[]
  after: PlacedHookContext[]
} {
  const before: PlacedHookContext[] = []
  const after: PlacedHookContext[] = []
  if (!Array.isArray(entries)) return { before, after }
  for (const x of entries) {
    const text = entryText(x)
    if (text === null || text.trim().length === 0) continue
    const origin = entryOrigin(x)
    const item: PlacedHookContext = origin === undefined ? { text } : { text, origin }
    if ((x as { position?: unknown }).position === "before") before.push(item)
    else after.push(item)
  }
  return { before, after }
}

/**
 * Split entries by position. A string, or an object with no `position`,
 * goes to `after`. Blank and malformed entries are dropped. Order is kept.
 */
export function splitHookContext(entries: readonly unknown[] | undefined): {
  before: string[]
  after: string[]
} {
  const placed = splitHookContextPlaced(entries)
  return {
    before: placed.before.map((e) => e.text),
    after: placed.after.map((e) => e.text),
  }
}
