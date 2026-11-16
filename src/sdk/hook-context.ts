/**
 * The one wrap for hook context strings that reach the model.
 *
 * Hook listeners can return `additionalContext` (tool channels,
 * `turn.willStart`, `turn.willStop`, `session.willStart`). Every site that
 * puts those strings in front of the model wraps them here, so the model
 * sees one stable shape.
 *
 * @module sdk/hook-context
 */

/** Keep the non-blank strings of a context list. */
export function cleanHookContext(lines: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(lines)) return []
  return lines.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
}

/**
 * Wrap each context line in one `<ma::agent::policy>` tag, one per line.
 * Returns `""` when no line is left after {@link cleanHookContext}.
 */
export function wrapHookContext(lines: readonly unknown[] | undefined): string {
  return cleanHookContext(lines)
    .map((n) => `<ma::agent::policy>${n}</ma::agent::policy>`)
    .join("\n")
}
