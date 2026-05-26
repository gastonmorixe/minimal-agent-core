/**
 * Unit test for {@link probeGlyphWidth}. Drives the probe against a
 * fake terminal that synthesizes CPR replies based on simulated cursor
 * advances, so we can verify the round-trip math without a real PTY.
 */

import { expect, test } from "bun:test"

import { type ProbeIO, probeGlyphWidth } from "./term-probe.ts"

/**
 * Build a fake terminal whose cursor advances by `advance` cells for
 * the given `glyph`, by 1 cell for ASCII (length 1) writes that aren't
 * the glyph, by `s.length` for any other plain text, and resets to
 * column 1 on `\r`. CPR (`ESC[6n`) requests are answered asynchronously
 * via `queueMicrotask` so the probe's whole write batch lands before
 * any reply is delivered (the realistic ordering).
 */
function makeFakeTerminal(
  glyph: string,
  advance: number,
): {
  io: ProbeIO
  writes: string[]
  /** If true, swallow CPR requests instead of replying (for timeout tests). */
  silent: { value: boolean }
} {
  const writes: string[] = []
  const silent = { value: false }
  let col = 1
  let handler: ((c: string) => void) | null = null

  const io: ProbeIO = {
    write(s) {
      writes.push(s)
      if (s === "\r") {
        col = 1
      } else if (s === "\x1b[6n") {
        if (silent.value) return
        const reply = `\x1b[1;${col}R`
        queueMicrotask(() => handler?.(reply))
      } else if (s === glyph) {
        col += advance
      } else {
        // Plain ASCII fallback (one cell per byte).
        col += s.length
      }
    },
    subscribe(h) {
      handler = h
      return () => {
        if (handler === h) handler = null
      }
    },
  }

  return { io, writes, silent }
}

test("probeGlyphWidth returns the observed cell advance", async () => {
  // Narrow case: ● (advance 1).
  const narrow = makeFakeTerminal("●", 1)
  expect(await probeGlyphWidth("●", narrow.io)).toBe(1)

  // Wide case: nf-md-tools 󱁤 (advance 2 in a patched Nerd Font Mono).
  const wide = makeFakeTerminal("\u{F1064}", 2)
  expect(await probeGlyphWidth("\u{F1064}", wide.io)).toBe(2)

  // Probe must have emitted exactly: \r, ESC[6n, glyph, ESC[6n.
  expect(wide.writes).toEqual(["\r", "\x1b[6n", "\u{F1064}", "\x1b[6n"])
})

test("probeGlyphWidth falls back when terminal does not reply", async () => {
  const { io, silent } = makeFakeTerminal("X", 1)
  silent.value = true

  // Use synchronous timeout impl so the test doesn't actually wait.
  let scheduled: (() => void) | null = null
  const result = probeGlyphWidth("X", io, {
    timeoutMs: 10,
    fallback: 1,
    setTimeoutImpl: (fn) => {
      scheduled = fn
      return 1
    },
    clearTimeoutImpl: () => {
      scheduled = null
    },
  })
  // Fire the timeout immediately.
  const fireTimeout = scheduled as (() => void) | null
  if (!fireTimeout) throw new Error("timeout was not scheduled")
  fireTimeout()
  expect(await result).toBe(1)
})
