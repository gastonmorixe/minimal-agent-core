/**
 * `/usage` command — open the interactive token-usage overlay.
 *
 *   /usage              → open the overlay (← → switch period, Esc close)
 *   /usage <period>     → print that period once to scrollback (no overlay)
 *
 * The overlay is painted into the editor's footer band via `editor.footer.set`
 * and driven by the `editor.key` handler, exactly like /config and the slash
 * menu. This handler's job: scan sessions once, precompute every period's
 * report, seed the singleton, paint the first frame, clear the typed `/usage`
 * from the prompt, and return `none` so the REPL prints nothing.
 *
 * Decoupling: the handler emits on the shared bus (`editor.overlay.open`,
 * `editor.footer.set`) and never imports the editor or queue directly. The
 * data + render live in the host's reusable `usage-stats` / `ui/usage/render`
 * modules (also used by the `usage` CLI command).
 *
 * @module usage/handlers/cmd_usage
 */

import type { CommandContext, CommandResult } from "@minimal-agent/plugin-api/types/plugin"

import { renderUsageReport } from "../../../src/ui/usage/render.ts"
import {
  aggregateAllPeriods,
  aggregateUsage,
  parseUsagePeriod,
  scanUsageEvents,
  USAGE_PERIODS,
} from "../../../src/usage-stats.ts"
import { DEFAULT_PERIOD_INDEX, renderOverlayFrame } from "../lib/overlay.ts"
import { openOverlay, USAGE_OVERLAY_OWNER } from "../lib/state.ts"

const MAX_ROWS = 6

function terminalCols(): number {
  const c = (process.stdout as { columns?: number }).columns
  return typeof c === "number" && c > 0 ? c : 80
}

/**
 * Command handler for `/usage`: toggles or renders the token-usage overlay
 * (per-turn and cumulative token/cost stats) for the session.
 */
export default function cmdUsage(ctx: CommandContext): CommandResult {
  const argv = ctx.argv.trim()

  // Headless path: an explicit period prints once, no overlay.
  if (argv.length > 0) {
    const period = parseUsagePeriod(argv)
    if (!period) {
      return {
        kind: "error",
        message: `unknown period "${argv}". Valid: ${USAGE_PERIODS.map((p) => p.id).join(", ")}`,
      }
    }
    const report = aggregateUsage(scanUsageEvents(), period)
    return { kind: "notice", lines: renderUsageReport(report, { cols: terminalCols() }) }
  }

  // Interactive path: scan once, precompute every period, open the overlay.
  const reports = aggregateAllPeriods(scanUsageEvents())
  openOverlay(reports, DEFAULT_PERIOD_INDEX)

  // Take MODAL ownership of the input line: the host hides the prompt row +
  // cursor, blocks submit (so the typed `/usage` can't leak to scrollback),
  // and routes every key here. The overlay is browse-only (no text edit), but
  // ownership is what hides the phantom prompt + blocks the scrollback leak.
  ctx.emit("editor.overlay.open", { owner: USAGE_OVERLAY_OWNER })

  const lines = renderOverlayFrame(reports, DEFAULT_PERIOD_INDEX, terminalCols(), MAX_ROWS)
  ctx.emit("editor.footer.set", { lines })

  // The overlay owns the input line + footer + keys now. Nothing to print, no
  // model turn.
  return { kind: "none" }
}
