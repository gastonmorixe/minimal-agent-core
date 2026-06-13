/**
 * Tests for {@link formatGoodbye} and {@link printGoodbye}.
 *
 * The banner is purely cosmetic — these tests pin the user-visible
 * invariants:
 *   - session id appears verbatim and copy-pasteable
 *   - the `--resume <sid>` line is on its own row (no inline decoration
 *     adjacent to the id that would break double/triple-click select)
 *   - degraded copy when session id missing
 *   - escape-hatch reason changes the closer copy
 */
import { describe, expect, it } from "bun:test"

import { formatGoodbye, printGoodbye } from "./goodbye-banner.ts"

const SID = "d5e415fb-bc89-4bfd-aba7-c41512830175"
const ANSI = /\x1b\[[\d;]*m/g
const strip = (s: string) => s.replace(ANSI, "")

describe("formatGoodbye", () => {
  it("includes the session id verbatim", () => {
    const lines = formatGoodbye({ sessionId: SID })
    const joined = lines.join("\n")
    expect(joined).toContain(SID)
  })

  it("has a dedicated resume line: 'minimal-agent --resume <sid>'", () => {
    const lines = formatGoodbye({ sessionId: SID })
    const resumeLine = lines.map(strip).find((l) => l.includes("--resume"))
    if (!resumeLine) throw new Error("missing resume line")
    expect(resumeLine).toContain(`minimal-agent --resume ${SID}`)
  })

  it("session id is NOT smushed against trailing punctuation (copy-paste safe)", () => {
    const lines = formatGoodbye({ sessionId: SID })
    const resumeLine = lines.map(strip).find((l) => l.includes("--resume"))!
    // line must END with the sid (modulo trailing whitespace) — no `.`,
    // no `)`, no `│` immediately after. Otherwise triple-click selects
    // the punctuation too.
    expect(resumeLine.trimEnd()).toMatch(new RegExp(`${SID}$`))
  })

  it("custom command name is honored", () => {
    const lines = formatGoodbye({ sessionId: SID, command: "ma" })
    const joined = strip(lines.join("\n"))
    expect(joined).toContain(`ma --resume ${SID}`)
    expect(joined).not.toContain("minimal-agent --resume")
  })

  it("degraded copy when session id is missing", () => {
    const lines = formatGoodbye({})
    const joined = strip(lines.join("\n"))
    expect(joined).not.toContain("--resume")
    expect(joined).toContain("no session id available")
  })

  it("degraded copy when session id is empty/whitespace", () => {
    const lines = formatGoodbye({ sessionId: "   " })
    const joined = strip(lines.join("\n"))
    expect(joined).not.toContain("--resume")
  })

  it("escape-hatch reason changes the closer copy", () => {
    const normal = strip(formatGoodbye({ sessionId: SID }).join("\n"))
    const hatch = strip(formatGoodbye({ sessionId: SID, reason: "escape-hatch" }).join("\n"))
    expect(normal).toContain("thanks for using minimal-agent")
    expect(hatch).toContain("force-quit")
    expect(hatch).not.toContain("thanks for using minimal-agent")
  })

  it("uses frame chrome matching the startup banner (╭│╰ rails)", () => {
    const lines = formatGoodbye({ sessionId: SID }).map(strip)
    expect(lines.some((l) => l.includes("╭"))).toBe(true)
    expect(lines.some((l) => l.includes("│"))).toBe(true)
    expect(lines.some((l) => l.includes("╰"))).toBe(true)
  })

  it("output is dim/styled (contains SGR escape sequences)", () => {
    const out = formatGoodbye({ sessionId: SID }).join("\n")
    expect(out).toMatch(ANSI)
  })

  it("starts and ends with a blank line (breathing room above scrollback)", () => {
    const lines = formatGoodbye({ sessionId: SID })
    expect(lines[0]).toBe("")
    expect(lines[lines.length - 1]).toBe("")
  })
})

describe("printGoodbye", () => {
  it("writes the formatted banner with trailing newline to the given stream", () => {
    const chunks: string[] = []
    const stream = { write: (s: string) => chunks.push(s) }
    printGoodbye({ sessionId: SID }, stream)
    const out = chunks.join("")
    expect(out).toContain(SID)
    expect(out.endsWith("\n")).toBe(true)
  })

  it("defaults to stderr when no stream is given (smoke; does not throw)", () => {
    // Just verify the call is well-formed; we don't want to actually
    // pollute test runner stderr, so we monkey-patch briefly.
    const origWrite = process.stderr.write.bind(process.stderr)
    let captured = ""
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stderr.write
    try {
      printGoodbye({ sessionId: SID })
    } finally {
      process.stderr.write = origWrite
    }
    expect(captured).toContain(SID)
  })
})
