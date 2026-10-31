/*
 * Tiny shared mutable holder for a decoration-line suffix string.
 *
 * The intercom / peer-roster line is set through `editor.setDecorationLines`.
 * This module lets the diagnostics plugin append a short LSP-status badge
 * onto the first decoration row without either module knowing about the other.
 *
 * Usage:
 *   // In the intercom renderer (or any code calling setDecorationLines):
 *   import { getDecorationSuffix } from "./decoration-suffix.ts"
 *   const suffix = getDecorationSuffix()
 *   lines[0] = suffix ? `${lines[0]} ${suffix}` : lines[0]
 *   editor.setDecorationLines(lines)
 *
 *   // In the diagnostics plugin's LSP-status updater:
 *   import { setDecorationSuffix } from "./decoration-suffix.ts"
 *   setDecorationSuffix("· ♻ sk-lsp · · tsgo")
 *
 * The suffix is a single styled string. Empty / null means append nothing.
 *
 * INTERNAL BRIDGE (spec S33): the public
 * `plugin-api/utils/decoration-suffix` contract this module used to back
 * moved to `minimal-agent-cli/src/terminal-kit`. This copy exists only so
 * `src/host/ui/status/live-area-scheduler.ts` keeps compiling until S34
 * moves it to the CLI, at which point this whole
 * `src/internal/terminal-render` folder is deleted — not exported, not
 * part of the public API, not reachable by a plugin.
 */

let suffix = ""

/** Get the current decoration-line suffix (or empty string for none). */
export function getDecorationSuffix(): string {
  return suffix
}

/**
 * Set the decoration-line suffix to a styled string.
 * Pass empty string to clear.
 */
export function setDecorationSuffix(text: string): void {
  suffix = text
}
