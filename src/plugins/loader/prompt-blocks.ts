/**
 * Prompt-block placement types + pure join helpers for PluginLoader.
 *
 * Split out of `src/plugins/loader.ts` to keep that file under the
 * `max-lines` lint budget. Public types are re-exported from loader.ts.
 *
 * @module plugins/loader/prompt-blocks
 */

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
