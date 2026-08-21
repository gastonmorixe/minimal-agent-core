/**
 * Regression tests for the "stacked renders on large paste" bug
 * (user-reported Aug 21 2026, session recorded under asciinema).
 *
 * Symptom: pasting a large multi-line text into the editor left multiple
 * stacked copies of the live-area frame (`ASK ❯ ─── ^ N more lines`
 * rows) in scrollback — one ghost per stdin-chunk repaint.
 *
 * Root cause (reproduced here in the cols-disagreement test): the
 * EditorRenderer wraps content at `output.columns` while Compositor's
 * eraseLiveSeq re-measures walk-up distance at its own
 * `effectiveColumns()`, which falls back to `$COLUMNS` when
 * `output.columns` is 0/stale. Under PTY wrappers (asciinema,
 * script(1), tmux) that propagate window size poorly, the two disagree;
 * every wrapped row then occupies a different physical height than the
 * erase math assumes, walk-up undershoots, and each of the N synchronous
 * per-chunk repaints pushes the previous frame up into scrollback.
 *
 * The paste path is additionally a paint storm (one full repaint per
 * stdin chunk — key-dispatch.ts consumePending → host.repaint()), which
 * multiplies any geometry deficit by the chunk count. Both are covered:
 *   - "single source of truth" tests pin renderer/erase col agreement;
 *   - "paste burst coalescing" pins N chunks → few paints.
 */

import { describe, expect, it } from "bun:test"

import { FakeTerminal } from "../test-utils/fake-terminal.ts"

import { FakeTTYInput } from "./editor-controller.fixtures.ts"
import { EditorController } from "./editor-controller.ts"
import { Compositor } from "./ui/compositor.ts"

/** Split `s` into `n` roughly-equal chunks (like stdin under load). */
function chunkify(s: string, n: number): string[] {
  const size = Math.ceil(s.length / n)
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

const PASTE_LINES = 80
function bigPastePayload(): string {
  const lines: string[] = []
  for (let i = 1; i <= PASTE_LINES; i++) {
    if (i % 5 === 0) lines.push(`line ${i} ${"word ".repeat(12)}`)
    else lines.push(`pasted line number ${i}`)
  }
  return lines.join("\n")
}

interface Harness {
  term: FakeTerminal
  stdin: FakeTTYInput
  ctrl: EditorController
  cleanup: () => void
}

function makeHarness(opts: {
  termCols: number
  /** Value the controller/renderer read via output.columns. */
  outColumns: number
  /** Env fallback the compositor sees via effectiveColumns(). */
  envColumns?: string
}): Harness {
  const prevEnv = process.env.COLUMNS
  if (opts.envColumns !== undefined) process.env.COLUMNS = opts.envColumns
  else delete process.env.COLUMNS

  const term = new FakeTerminal({ cols: opts.termCols, rows: 10, scrollbackLimit: 5000 })
  const stdin = new FakeTTYInput()
  const output = {
    isTTY: true as const,
    get columns(): number {
      return opts.outColumns
    },
    rows: term.rows,
    write: (s: string) => {
      term.feed(s)
      return true
    },
  }
  const compositor = new Compositor({ output })
  compositor.mount()
  const ctrl = new EditorController({
    prompt: "ASK ❯ ",
    continuationPrompt: "  ",
    // biome-ignore lint/suspicious/noExplicitAny: test harness wiring
    compositor: compositor as any,
    // biome-ignore lint/suspicious/noExplicitAny: test harness wiring
    stdin: stdin as any,
    // biome-ignore lint/suspicious/noExplicitAny: test harness wiring
    output: output as any,
    maxLiveHeight: 8,
    resizeDebounceMs: 0,
  })
  ctrl.start()
  term.scrollback.length = 0
  return {
    term,
    stdin,
    ctrl,
    cleanup: () => {
      ctrl.stop()
      if (prevEnv === undefined) delete process.env.COLUMNS
      else process.env.COLUMNS = prevEnv
    },
  }
}

function ghostCount(term: FakeTerminal): number {
  return term.scrollback.filter((l) => l.includes("ASK") || /more lines?$/.test(l)).length
}

describe("EditorController — large paste must not stack frames into scrollback", () => {
  it("multi-chunk bracketed paste with agreeing cols leaves clean scrollback", () => {
    const h = makeHarness({ termCols: 40, outColumns: 40 })
    try {
      h.stdin.send("\x1b[200~")
      for (const c of chunkify(bigPastePayload(), 12)) h.stdin.send(c)
      h.stdin.send("\x1b[201~")
      expect(ghostCount(h.term)).toBe(0)
    } finally {
      h.cleanup()
    }
  })

  it("renderer cols and compositor erase cols agree when output.columns=0 + $COLUMNS", () => {
    // The documented script(1)/asciinema case: output.columns is 0 and
    // the compositor falls back to $COLUMNS. Both sides must resolve the
    // SAME width or every wrapped row desyncs the erase math.
    const h = makeHarness({ termCols: 40, outColumns: 0, envColumns: "40" })
    try {
      h.stdin.send("\x1b[200~")
      for (const c of chunkify(bigPastePayload(), 12)) h.stdin.send(c)
      h.stdin.send("\x1b[201~")
      expect(ghostCount(h.term)).toBe(0)
    } finally {
      h.cleanup()
    }
  })

  it("cols disagreement between controller and compositor must not stack frames", () => {
    // Reproduction of the user report: renderer sees 60, compositor's
    // env fallback says 45. Before the fix this stacks ~21 ghost frames.
    const h = makeHarness({ termCols: 45, outColumns: 60, envColumns: "45" })
    try {
      h.stdin.send("\x1b[200~")
      for (const c of chunkify(bigPastePayload(), 12)) h.stdin.send(c)
      h.stdin.send("\x1b[201~")
      expect(ghostCount(h.term)).toBe(0)
    } finally {
      h.cleanup()
    }
  })

  it("a 12-chunk paste burst coalesces to few paints instead of one per chunk", () => {
    const h = makeHarness({ termCols: 40, outColumns: 40 })
    try {
      // Count full-frame paints through the real compositor's output:
      // each setLiveArea batch carries hide-cursor + at least one EL.
      const paints = { n: 0 }
      const term = h.term
      const feed = term.feed.bind(term)
      ;(term as unknown as { feed: (s: string) => void }).feed = (s: string) => {
        if (s.includes("\x1b[?25l") && s.includes("\x1b[K")) paints.n++
        return feed(s)
      }

      h.stdin.send("\x1b[200~")
      for (const c of chunkify(bigPastePayload(), 12)) h.stdin.send(c)
      h.stdin.send("\x1b[201~")

      expect(paints.n).toBeLessThanOrEqual(3)
    } finally {
      h.cleanup()
    }
  })
})
