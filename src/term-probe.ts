/**
 * Runtime cell-advance probe via DSR / CPR.
 *
 * The width of a Nerd Font PUA glyph (or any non-trivial code point) on
 * the user's screen depends on the active terminal × font combination.
 * Our `term-width.ts` table is a best-guess; iTerm + a patched Nerd Font
 * Mono renders `U+F1064` two cells wide while advancing the cursor only
 * one cell, which makes the right half of the glyph overdraw the next
 * cell (see the long discussion in src/live-area-status.ts and the
 * memory log).
 *
 * The only way to know for sure is to ask the terminal: write the glyph,
 * fire a Cursor Position Report (`ESC[6n`), parse `ESC[<row>;<col>R`,
 * and subtract.
 *
 * This module is the I/O-injectable core. It does NOT touch real stdio;
 * callers wire it to `process.stdout` / `process.stdin` (or a tmux/test
 * harness). That keeps it unit-testable without spawning a real PTY.
 *
 * @module term-probe
 */

/** Minimal I/O surface needed for the probe. */
export interface ProbeIO {
  /** Write bytes toward the terminal (typically `process.stdout`). */
  write(text: string): void
  /**
   * Subscribe to bytes coming back FROM the terminal (typically
   * `process.stdin` in raw mode). Returns an unsubscribe function.
   */
  subscribe(handler: (chunk: string) => void): () => void
}

export interface ProbeOptions {
  /** Milliseconds before the probe gives up and resolves with `fallback`. */
  timeoutMs?: number
  /** Width returned when the terminal does not reply in time. */
  fallback?: number
  /** Injection seam for tests. */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
}

const CPR_RE = /\x1b\[(\d+);(\d+)R/

/**
 * Measure the visual cell advance of `glyph` in the connected terminal.
 *
 * Strategy: anchor with `\r`, ask CPR for the start column, write the
 * glyph, ask CPR for the end column. Width = end - start. Two probes
 * (rather than assuming "after \r we're at col 1") so the call is safe
 * even when the user's prompt or some other writer left the cursor at
 * an arbitrary column.
 */
export function probeGlyphWidth(
  glyph: string,
  io: ProbeIO,
  opts: ProbeOptions = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 50
  const fallback = opts.fallback ?? 1
  const setT = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  return new Promise<number>((resolve) => {
    let buf = ""
    const cols: number[] = []
    let done = false
    let timer: unknown = null

    const finish = (value: number) => {
      if (done) return
      done = true
      if (timer !== null) clearT(timer)
      unsub()
      resolve(value)
    }

    const unsub = io.subscribe((chunk) => {
      buf += chunk
      // Drain every CPR reply currently buffered.
      while (true) {
        const m = buf.match(CPR_RE)
        if (!m || m.index === undefined) break
        cols.push(Number(m[2]))
        buf = buf.slice(m.index + m[0].length)
        if (cols.length >= 2) {
          const width = cols[1] - cols[0]
          finish(width >= 0 ? width : fallback)
          return
        }
      }
    })

    timer = setT(() => finish(fallback), timeoutMs)

    // Anchor, measure start, emit glyph, measure end.
    io.write("\r")
    io.write("\x1b[6n")
    io.write(glyph)
    io.write("\x1b[6n")
  })
}
