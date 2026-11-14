/**
 * Prompt-block placement types + pure join helpers for PluginLoader.
 *
 * Split out of `src/plugins/loader.ts` to keep that file under the
 * `max-lines` lint budget. Public types are re-exported from loader.ts.
 *
 * @module plugins/loader/prompt-blocks
 */

import type { PromptRole } from "./helpers.ts"

/**
 * Where a resolved prompt fragment is assembled in the system body.
 * Mirrors manifest `placement`; default at runtime is `"sessionContext"`.
 */
export type PromptFragmentPlacement = "sessionContext" | "afterInstructions"

/**
 * Dual system-prompt contribution from loaded plugins.
 *
 * - `afterInstructions`: plain markdown joined from fragments with
 *   `placement: "afterInstructions"`. No `<ma::sys::…>` wrap, no PROMPT.md.
 * - `sessionContext`: existing role-wrapped block from PROMPT.md + fragments
 *   with default/`sessionContext` placement.
 */
export type PluginPromptBlocks = {
  /** Plain markdown (no `<ma::sys`). `null` if empty. */
  afterInstructions: string | null
  /** Existing XML-wrapped plugin sections. `null` if empty. */
  sessionContext: string | null
}

/** One async prompt fragment in flight (loader-internal). */
export interface PendingFragment {
  pluginId: string
  fragmentId: string
  order: number
  placement: PromptFragmentPlacement
  startedAt: number
  promise: Promise<string | null>
}

/** One successfully resolved fragment after timeout/error filtering. */
export interface ResolvedFragment {
  pluginId: string
  fragmentId: string
  order: number
  placement: PromptFragmentPlacement
  text: string
}

/** One afterInstructions fragment range in `PluginPromptBlocks.afterInstructions`. */
export interface PromptFragmentSpan {
  /** Manifest id of the plugin that owns the fragment. */
  readonly pluginId: string
  /** Fragment id in that manifest. */
  readonly fragmentId: string
  /** UTF-16 offset where the fragment text starts. */
  readonly start: number
  /** UTF-16 offset where the fragment text ends (exclusive). */
  readonly end: number
}

/** One `<ma::sys::ROLE name="...">` section of the sessionContext block, with its owner. */
export interface SessionContextSection {
  /** The section role. */
  readonly role: PromptRole
  /** The final section name, after the `-N` suffix, not escaped. */
  readonly name: string
  /** Manifest id of the plugin that owns the section. */
  readonly pluginId: string
  /** Absolute package directory of that plugin. */
  readonly packageDir: string
}

/** Owners of the plugin system-prompt text, as data. */
export interface PromptProvenance {
  /** Fragment ranges in `PluginPromptBlocks.afterInstructions`, in text order. */
  readonly afterInstructions: readonly PromptFragmentSpan[]
  /** Sections of `PluginPromptBlocks.sessionContext`, in wire order. */
  readonly sessionContext: readonly SessionContextSection[]
}

/** Owner of one plugin tool. */
export interface ToolOwner {
  /** Manifest id of the plugin that owns the tool. */
  readonly pluginId: string
  /** Absolute package directory of that plugin. */
  readonly packageDir: string
}

/**
 * The fragment ranges of {@link joinAfterInstructions}: same filter, same
 * `trimEnd`, same `"\n\n"` join, so each span slices back to its fragment.
 */
export function afterInstructionsSpans(
  resolved: readonly ResolvedFragment[],
): PromptFragmentSpan[] {
  const spans: PromptFragmentSpan[] = []
  let offset = 0
  for (const r of resolved) {
    if (r.placement !== "afterInstructions") continue
    const t = r.text.trimEnd()
    if (t.length === 0) continue
    if (spans.length > 0) offset += 2
    spans.push({
      pluginId: r.pluginId,
      fragmentId: r.fragmentId,
      start: offset,
      end: offset + t.length,
    })
    offset += t.length
  }
  return spans
}

/** Join afterInstructions fragments (already order-sorted) into plain markdown. */
export function joinAfterInstructions(resolved: readonly ResolvedFragment[]): string | null {
  const parts: string[] = []
  for (const r of resolved) {
    if (r.placement !== "afterInstructions") continue
    const t = r.text.trimEnd()
    if (t.length > 0) parts.push(t)
  }
  return parts.length > 0 ? parts.join("\n\n") : null
}

/** Group sessionContext-placement fragment texts by plugin id. */
export function groupSessionContextFragments(
  resolved: readonly ResolvedFragment[],
): Map<string, string[]> {
  const sessionFrags = new Map<string, string[]>()
  for (const r of resolved) {
    if (r.placement !== "sessionContext") continue
    const arr = sessionFrags.get(r.pluginId) ?? []
    arr.push(r.text)
    sessionFrags.set(r.pluginId, arr)
  }
  return sessionFrags
}
