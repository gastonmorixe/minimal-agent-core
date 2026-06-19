/**
 * Live-area slot handler for the diagnostics plugin.
 *
 * Periodically updates the decoration suffix with a compact line showing
 * which persistent LSP providers are currently active (booted and alive).
 * The suffix is appended to the first header decoration row by the
 * LiveAreaScheduler so it shares the intercom roster line.
 *
 * Returns null (no slot content) — the visual is handled by the suffix.
 *
 * @module plugins/diagnostics/handlers/lsp-status-slot
 */

import type { LiveAreaHandlerContext } from "@minimal-agent/plugin-api/types/plugin"
import { ansiStyle as c } from "@minimal-agent/plugin-api/utils/ansi"
import { setDecorationSuffix } from "@minimal-agent/plugin-api/utils/decoration-suffix"

import { getActivePersistentProviders } from "./on_tool_did_invoke.ts"

/**
 * Icons for known persistent providers. Falls back to "⚙" for unknown ids.
 */
const ICONS: Record<string, string> = {
  tsgo: "\u2322", // ⌢ (TypeScript)
  "sourcekit-lsp": "\u267b", // ♻ (Swift/Obj-C)
}

const ICON_FALLBACK = "\u2699" // ⚙

/**
 * Poll active LSP providers every 3s and update the decoration suffix.
 * Returns null so no separate header line is rendered — the suffix rides
 * on the first decoration row (intercom roster line).
 */
export default async function lspStatusSlot(_ctx: LiveAreaHandlerContext): Promise<string | null> {
  const active = getActivePersistentProviders()
  if (active.length === 0) {
    setDecorationSuffix("")
    return null
  }

  const parts = active.map((id) => {
    const icon = ICONS[id] ?? ICON_FALLBACK
    const label = id === "sourcekit-lsp" ? "sk-lsp" : id
    return c.dim(`${icon} ${label}`)
  })

  setDecorationSuffix(` ${parts.join(c.dim(" \u00b7 "))}`)
  return null
}
