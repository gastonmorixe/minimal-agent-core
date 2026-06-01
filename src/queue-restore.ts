/**
 * Pure formatter for restoring queued messages back into the editor
 * prompt.
 *
 * Two callers in `runReplLiveArea` (`./agent/repl-live-area.ts`) hand a
 * list of message texts to put back into the editor buffer:
 *
 *   1. The "dequeue all" action (`k`) in queue-navigation mode.
 *   2. The abort path: when a turn is cancelled (Esc / Ctrl+C), the
 *      in-flight prompt PLUS every still-queued message are returned to
 *      the input so nothing the user typed is lost.
 *
 * Formatting rule (from the feature request):
 *
 *   - 0 non-empty messages  → "" (empty buffer)
 *   - exactly 1 message     → that text verbatim (no decoration)
 *   - more than 1 message   → an ordinal list:
 *
 *         1. first message
 *         2. second message
 *         N. last message
 *
 * Multi-line messages keep their newlines; continuation lines are
 * indented to align under the text after the `N. ` marker so the list
 * stays readable:
 *
 *         1. fix the wrap bug
 *            it only repros at width 80
 *         2. then run the formatter
 *
 * Empty / whitespace-only entries are dropped before counting (a
 * synthetic zero-text queue item — pushed by the Alt+M mode-interrupt
 * path — must never materialize as a blank `N.` line). Dropping them
 * also means "one real message + one synthetic" restores as the single
 * real message verbatim, not as a one-item numbered list.
 *
 * Pure: no I/O, no state. Unit-tested in `queue-restore.test.ts`.
 *
 * @module queue-restore
 */

/**
 * Format a list of queued message texts for restoration into the editor
 * buffer. See the module docstring for the exact rules.
 *
 * @param texts - Message texts in submission order (FIFO).
 * @returns The buffer text to set via `editor.setBuffer(...)`.
 */
export function formatRestoredMessages(texts: readonly string[]): string {
  const items = texts.filter((t) => t.trim().length > 0)
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]
  return items
    .map((text, i) => {
      const prefix = `${i + 1}. `
      const indent = " ".repeat(prefix.length)
      return text
        .split("\n")
        .map((line, li) => (li === 0 ? `${prefix}${line}` : `${indent}${line}`))
        .join("\n")
    })
    .join("\n")
}
