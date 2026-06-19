/*
 * Tiny shared mutable holder for a decoration-line suffix string.
 *
 * The intercom / peer-roster line is set through `editor.setDecorationLines`.
 * This module lets the diagnostics plugin append a short LSP-status badge
 * onto the first decoration row without either module knowing about the other.
 *
 * Usage:
 *   // In the intercom renderer (or any code calling setDecorationLines):
 *   import { getDecorationSuffix } from "@minimal-agent/plugin-api/utils/decoration-suffix"
 *   const suffix = getDecorationSuffix()
 *   lines[0] = suffix ? `${lines[0]} ${suffix}` : lines[0]
 *   editor.setDecorationLines(lines)
 *
 *   // In the diagnostics plugin's LSP-status updater:
 *   import { setDecorationSuffix } from "@minimal-agent/plugin-api/utils/decoration-suffix"
 *   setDecorationSuffix("· ♻ sk-lsp · ⌢ tsgo")
 *
 * The suffix is a single styled string. Empty / null means append nothing.
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
