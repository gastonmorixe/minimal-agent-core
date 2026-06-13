/**
 * `usage [<period>]` — token-usage statistics across all saved sessions.
 *
 * Two modes:
 *   - Interactive (TTY, no explicit period): an arrow-key period switcher.
 *     ← / → (or h / l) cycle Today → Last 24h → Last 30d → YTD → Last year →
 *     All time; number keys 1-6 jump; q / Esc / Ctrl+C exit. The chart
 *     repaints in place.
 *   - One-shot: an explicit period arg (`usage month`) OR a non-TTY stdout
 *     (piped / redirected) prints that period (default: all time) and exits.
 *
 * The data engine is `usage-stats.ts`; the renderer is the shared
 * `@minimal-agent/plugin-api/utils/usage-render` leaf utility also used by the
 * `/usage` live-area overlay.
 *
 * @module commands/usage
 */

import { renderUsageReport } from "@minimal-agent/plugin-api/utils/usage-render"

import { modelShortLabel } from "../llm/model-label.ts"
import {
  aggregateAllPeriods,
  aggregateUsage,
  parseUsagePeriod,
  scanUsageEvents,
  USAGE_PERIODS,
  type UsagePeriod,
} from "../usage-stats.ts"

export interface RunUsageOptions {
  /** Explicit period token from argv (e.g. `"month"`). Undefined ⇒ default. */
  period?: string
  /** Force one-shot (no interactive loop) even on a TTY. */
  noInteractive?: boolean
}

function cols(): number {
  const n = (process.stdout as { columns?: number }).columns
  return typeof n === "number" && n > 0 ? n : 80
}

/**
 * `usage` entrypoint. Resolves interactive vs one-shot, then renders.
 * Returns when the user exits (interactive) or after one print (one-shot).
 */
export async function runUsageCommand(opts: RunUsageOptions = {}): Promise<void> {
  const explicit = parseUsagePeriod(opts.period)
  if (opts.period && !explicit) {
    console.error(
      `  unknown period "${opts.period}". Valid: ${USAGE_PERIODS.map((p) => p.id).join(", ")}`,
    )
    process.exitCode = 1
    return
  }

  const events = scanUsageEvents()

  // One-shot when: an explicit period was given, OR stdout isn't a TTY
  // (piped / redirected — interactive repaint would be garbage), OR the
  // caller forced it.
  const isTTY = process.stdout.isTTY === true && process.stdin.isTTY === true
  const oneShot = explicit !== null || !isTTY || opts.noInteractive === true

  if (oneShot) {
    const period: UsagePeriod = explicit ?? "all"
    const report = aggregateUsage(events, period)
    console.log(renderUsageReport(report, { cols: cols(), modelLabel: modelShortLabel }).join("\n"))
    return
  }

  await runInteractive(events)
}

/**
 * Interactive period switcher. Pre-computes every period from one scan,
 * paints the active one, and repaints on arrow/number keys. Restores the
 * terminal and clears the chart on exit.
 */
async function runInteractive(events: ReturnType<typeof scanUsageEvents>): Promise<void> {
  const reports = aggregateAllPeriods(events)
  let idx = USAGE_PERIODS.length - 1 // default to "All time"

  const stdout = process.stdout
  const stdin = process.stdin

  // Track how many lines we painted so we can clear them before a repaint.
  let lastLineCount = 0
  const clearPrevious = (): void => {
    if (lastLineCount === 0) return
    // Move cursor up lastLineCount lines and clear to end of screen.
    stdout.write(`\x1b[${lastLineCount}A\x1b[0J`)
  }
  const paint = (): void => {
    clearPrevious()
    const period = USAGE_PERIODS[idx]!.id
    const lines = renderUsageReport(reports[period], { cols: cols(), modelLabel: modelShortLabel })
    const footer = "  \x1b[2m← → switch period · 1-6 jump · q quit\x1b[0m"
    const all = [...lines, footer]
    stdout.write(`${all.join("\n")}\n`)
    lastLineCount = all.length
  }

  return new Promise<void>((resolve) => {
    const wasRaw = stdin.isRaw === true
    try {
      stdin.setRawMode?.(true)
    } catch {
      // Non-settable stdin: fall back to a single paint + return.
      paint()
      resolve()
      return
    }
    stdin.resume()
    // Hide the cursor during the interactive session.
    stdout.write("\x1b[?25l")
    paint()

    const cleanup = (): void => {
      stdin.off("data", onData)
      try {
        stdin.setRawMode?.(wasRaw)
      } catch {
        // best-effort
      }
      stdin.pause()
      stdout.write("\x1b[?25h") // show cursor
      resolve()
    }

    const move = (delta: number): void => {
      idx = (idx + delta + USAGE_PERIODS.length) % USAGE_PERIODS.length
      paint()
    }

    const onData = (buf: Buffer): void => {
      const s = buf.toString("utf8")
      // Ctrl+C (0x03), q, Q, Esc-alone → quit.
      if (s === "\x03" || s === "q" || s === "Q") {
        cleanup()
        return
      }
      // Arrow keys: ESC [ C (right) / ESC [ D (left). Also h/l (vim).
      if (s === "\x1b[C" || s === "l") {
        move(1)
        return
      }
      if (s === "\x1b[D" || s === "h") {
        move(-1)
        return
      }
      // Bare Esc (not a CSI sequence) → quit.
      if (s === "\x1b") {
        cleanup()
        return
      }
      // Number keys 1-6 jump directly.
      const n = Number.parseInt(s, 10)
      if (Number.isInteger(n) && n >= 1 && n <= USAGE_PERIODS.length) {
        idx = n - 1
        paint()
      }
    }

    stdin.on("data", onData)
  })
}
