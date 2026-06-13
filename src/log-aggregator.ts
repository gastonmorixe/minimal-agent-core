/**
 * Footer-band aggregator: merges TUI diagnostic lines + plugin-contributed
 * footer lines into one `setFooterLines(...)` call on the editor.
 *
 * # Why an aggregator
 *
 * Two sources want to paint into the editor's footer band:
 *
 *   1. `TuiDiagnosticSurface` — 0..2 lines of "last warn / last error
 *      with count" (`src/log-tui.ts`).
 *   2. `LiveAreaScheduler` — N lines of plugin-contributed slots, e.g.
 *      the quota footer (`src/live-area-providers.ts`).
 *
 * Both push to `setFooterLines`. If they pushed independently each
 * would overwrite the other on every change.
 *
 * The aggregator absorbs both pushes, keeps the latest values from
 * each, and writes the merged `[diagnostic..., plugin...]` array to a
 * single `setFooterLines(lines)` callback on every change.
 *
 * # Decoration band
 *
 * `setDecorationLines` (the band ABOVE the editor) is owned by the
 * queue-decoration display; the live-area scheduler can write into it
 * via the manifest's `position: "header"` — but right now only the
 * queue uses it. We pass-through plugin decoration writes unchanged.
 *
 * @module log-aggregator
 */

import type { LiveAreaSink } from "./live-area-providers.ts"
import type { DiagnosticLinesSink } from "./log-tui.ts"

/**
 * Merges the two writers that share the footer band below the editor:
 * diagnostic lines (warn/error chips) and plugin footer lines. Each side can
 * update independently; every change re-emits the concatenated
 * `[diagnostic..., plugin...]` array so neither writer clobbers the other.
 */
export class FooterAggregator {
  private diagnosticLines: string[] = []
  private pluginFooterLines: string[] = []

  constructor(
    /** Called with the merged `[diagnostic..., plugin...]` array on every change. */
    private readonly setFooter: (lines: string[]) => void,
    /** Plugin decoration passthrough. */
    private readonly setDecoration: (lines: string[]) => void,
  ) {}

  /** Sink for `TuiDiagnosticSurface`. */
  diagnosticSink(): DiagnosticLinesSink {
    return {
      setDiagnosticLines: (lines) => {
        this.diagnosticLines = lines
        this.flushFooter()
      },
    }
  }

  /** Sink for `LiveAreaScheduler`. */
  pluginSink(): LiveAreaSink {
    return {
      setFooterLines: (lines) => {
        this.pluginFooterLines = lines
        this.flushFooter()
      },
      setDecorationLines: (lines) => {
        // Pass-through. The decoration band isn't shared with the
        // diagnostic surface (yet); we hand the lines straight to the
        // editor. If we ever stack agent-owned content above plugin
        // decoration, that merging lives here.
        this.setDecoration(lines)
      },
    }
  }

  private flushFooter(): void {
    this.setFooter([...this.diagnosticLines, ...this.pluginFooterLines])
  }
}
