/**
 * Real-terminal smoke test for {@link probeGlyphWidth}. Skipped unless
 * `MINIMAL_AGENT_REAL_PROBE=1` AND stdio is attached to a TTY, because
 * it needs to put stdin in raw mode and parse CPR replies from the
 * actual emulator.
 *
 * Run from inside the target terminal (iTerm, WezTerm, etc.) with:
 *   MINIMAL_AGENT_REAL_PROBE=1 bun test src/term-probe.real.test.ts
 *
 * The test prints a measurement table and asserts ONLY the ASCII
 * sanity case. The PUA / Nerd Font widths are recorded for the human
 * to read — the whole point of running this is that we don't know
 * them ahead of time and unit tests can't see them.
 */

import { test, expect } from "bun:test"
import { openSync, writeSync, createReadStream, closeSync, existsSync } from "node:fs"
import { probeGlyphWidth, type ProbeIO } from "./term-probe.ts"

// We talk to /dev/tty directly because `bun test` captures process.stdout
// (its isTTY is undefined inside test workers), which would silently
// swallow our CPR queries.
const enabled = process.env.MINIMAL_AGENT_REAL_PROBE === "1" && existsSync("/dev/tty")

const maybe = enabled ? test : test.skip

maybe("probeGlyphWidth measures real terminal cell advance", async () => {
  const ttyW = openSync("/dev/tty", "w")
  const ttyR = createReadStream("/dev/tty")
  // Best-effort raw mode on the underlying fd.
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  stdin.setRawMode?.(true)

  const io: ProbeIO = {
    write: (s) => void writeSync(ttyW, s),
    subscribe: (h) => {
      const onData = (chunk: Buffer | string) =>
        h(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      ttyR.on("data", onData)
      return () => void ttyR.off("data", onData)
    },
  }
  try {
    const cases = [
      { name: "ASCII X", glyph: "X" },
      { name: "BLACK CIRCLE ●", glyph: "\u25CF" },
      { name: "nf-md-tools 󱁤", glyph: "\u{F1064}" },
      { name: "nf-fa-cog 󰒓", glyph: "\u{F0493}" },
    ]
    const results: Array<{ name: string; advance: number }> = []
    for (const c of cases) {
      const advance = await probeGlyphWidth(c.glyph, io, { timeoutMs: 200 })
      results.push({ name: c.name, advance })
    }

    writeSync(ttyW, "\r\nterm-probe results:\r\n")
    for (const r of results) {
      writeSync(ttyW, `  ${r.name.padEnd(20)} advance=${r.advance}\r\n`)
    }
    console.log("term-probe results:")
    for (const r of results) {
      console.log(`  ${r.name.padEnd(20)} advance=${r.advance}`)
    }

    const ascii = results.find((r) => r.name === "ASCII X")
    expect(ascii?.advance).toBe(1)

    for (const r of results) {
      expect(r.advance).toBeGreaterThanOrEqual(0)
      expect(r.advance).toBeLessThanOrEqual(4)
    }
  } finally {
    if (!wasRaw) stdin.setRawMode?.(false)
    ttyR.close()
    closeSync(ttyW)
  }
})
