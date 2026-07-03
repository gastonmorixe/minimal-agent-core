/**
 * Unit tests for the RFC 5424 syslog formatter.
 *
 * Reference: https://datatracker.ietf.org/doc/html/rfc5424
 *
 * Spec under test (HEADER):
 *
 *   <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID
 *
 * - PRI: `<` + (facility × 8 + severity) + `>`, e.g. `<11>` = facility 1
 *   (user) × 8 + severity 3 (error).
 * - VERSION: always `1`.
 * - TIMESTAMP: RFC 3339 with timezone. We emit UTC ISO-8601 with `Z`.
 * - HOSTNAME / APP-NAME / PROCID / MSGID: NILVALUE `-` when missing.
 *
 * STRUCTURED-DATA: `[SD-ID name="value" ...]` or `-` when empty.
 * - SD-NAME must be PRINTUSASCII excluding `=`, `]`, `"`, SP. We sanitize
 *   illegal chars to `_`.
 * - SD-PARAM-VALUE must escape `"`, `\`, `]`.
 *
 * MSG: arbitrary, but CR/LF are inappropriate in a one-line-per-event
 * file format — we escape them to `\\n` / `\\r`.
 */

import { describe, expect, it } from "bun:test"

import { Facility, type LogEvent, Severity } from "../bus/diagnostic-bus.ts"

import { formatRfc5424 } from "./syslog.ts"

function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: Date.UTC(2026, 4, 20, 11, 14, 37, 412), // 2026-05-20T11:14:37.412Z
    severity: Severity.Warning,
    facility: Facility.User,
    source: "live-area.timeout",
    message: "invoke did not resolve in time",
    ...over,
  }
}

describe("formatRfc5424 — PRI", () => {
  it("computes PRI = facility * 8 + severity", () => {
    // user (1) × 8 + warning (4) = 12
    const line = formatRfc5424(event(), { hostname: "host", procId: 100 })
    expect(line.startsWith("<12>")).toBe(true)
  })

  it("user + error = 11", () => {
    const line = formatRfc5424(event({ severity: Severity.Error }), {
      hostname: "host",
      procId: 100,
    })
    expect(line.startsWith("<11>")).toBe(true)
  })

  it("local0 + warning = 132", () => {
    const line = formatRfc5424(event({ facility: Facility.Local0, severity: Severity.Warning }), {
      hostname: "host",
      procId: 100,
    })
    expect(line.startsWith("<132>")).toBe(true)
  })

  it("user + debug = 15", () => {
    const line = formatRfc5424(event({ severity: Severity.Debug }), {
      hostname: "host",
      procId: 100,
    })
    expect(line.startsWith("<15>")).toBe(true)
  })

  it("user + emergency = 8", () => {
    const line = formatRfc5424(event({ severity: Severity.Emergency }), {
      hostname: "host",
      procId: 100,
    })
    expect(line.startsWith("<8>")).toBe(true)
  })
})

describe("formatRfc5424 — header", () => {
  it("emits VERSION=1 after PRI", () => {
    const line = formatRfc5424(event(), { hostname: "h", procId: 1 })
    expect(line.startsWith("<12>1 ")).toBe(true)
  })

  it("emits RFC3339 UTC timestamp with millis", () => {
    const line = formatRfc5424(event(), { hostname: "h", procId: 1 })
    // 2026-05-20T11:14:37.412Z
    expect(line).toContain(" 2026-05-20T11:14:37.412Z ")
  })

  it("includes hostname, app-name, procid, msgid as separate fields", () => {
    const line = formatRfc5424(event(), {
      hostname: "macbookpro.home.arpa",
      appName: "minimal-agent",
      procId: 87654,
    })
    // <12>1 <ts> macbookpro.home.arpa minimal-agent 87654 live-area.timeout - <msg>
    const parts = line.split(" ")
    expect(parts[2]).toBe("macbookpro.home.arpa")
    expect(parts[3]).toBe("minimal-agent")
    expect(parts[4]).toBe("87654")
    expect(parts[5]).toBe("live-area.timeout")
  })

  it("defaults hostname to NILVALUE '-' when omitted", () => {
    const line = formatRfc5424(event(), { procId: 1 })
    expect(line.split(" ")[2]).toBe("-")
  })

  it("defaults procid to NILVALUE '-' when omitted", () => {
    const line = formatRfc5424(event(), { hostname: "h" })
    expect(line.split(" ")[4]).toBe("-")
  })

  it("defaults appName to minimal-agent", () => {
    const line = formatRfc5424(event(), { hostname: "h", procId: 1 })
    expect(line.split(" ")[3]).toBe("minimal-agent")
  })

  it("uses NILVALUE '-' for empty source (msgid)", () => {
    const line = formatRfc5424(event({ source: "" }), {
      hostname: "h",
      procId: 1,
    })
    expect(line.split(" ")[5]).toBe("-")
  })
})

describe("formatRfc5424 — STRUCTURED-DATA", () => {
  it("emits '-' when structuredData is absent", () => {
    const line = formatRfc5424(event(), { hostname: "h", procId: 1 })
    // header has 6 fields, then SD, then MSG. SD is the 7th token.
    expect(line.split(" ")[6]).toBe("-")
  })

  it("emits '-' when structuredData is empty", () => {
    const line = formatRfc5424(event({ structuredData: {} }), {
      hostname: "h",
      procId: 1,
    })
    expect(line.split(" ")[6]).toBe("-")
  })

  it('emits [sdId k="v" k2="v2"] for non-empty data', () => {
    const line = formatRfc5424(
      event({
        structuredData: { slot: "quota-status/quota", "timeout-ms": 8000 },
      }),
      { hostname: "h", procId: 1 },
    )
    expect(line).toContain(' [ma@local slot="quota-status/quota" timeout-ms="8000"] ')
  })

  it("uses custom sdId when provided", () => {
    const line = formatRfc5424(event({ structuredData: { k: "v" } }), {
      hostname: "h",
      procId: 1,
      sdId: "ma@52173",
    })
    expect(line).toContain('[ma@52173 k="v"]')
  })

  it('escapes " \\ ] in values per RFC 5424 §6.3.3', () => {
    const line = formatRfc5424(
      event({
        structuredData: { v: 'a"b\\c]d' },
      }),
      { hostname: "h", procId: 1 },
    )
    expect(line).toContain('v="a\\"b\\\\c\\]d"')
  })

  it("sanitizes forbidden chars in keys to underscore", () => {
    const line = formatRfc5424(
      event({
        structuredData: { "bad key": "1", "k=eq": "2", "k]close": "3", 'k"quote': "4" },
      }),
      { hostname: "h", procId: 1 },
    )
    // All four keys collapse to safe forms
    expect(line).toContain('bad_key="1"')
    expect(line).toContain('k_eq="2"')
    expect(line).toContain('k_close="3"')
    expect(line).toContain('k_quote="4"')
  })

  it("serializes numbers and booleans as their string forms", () => {
    const line = formatRfc5424(event({ structuredData: { n: 42, f: 3.14, t: true, fls: false } }), {
      hostname: "h",
      procId: 1,
    })
    expect(line).toContain('n="42"')
    expect(line).toContain('f="3.14"')
    expect(line).toContain('t="true"')
    expect(line).toContain('fls="false"')
  })
})

describe("formatRfc5424 — MSG", () => {
  it("places the message after STRUCTURED-DATA, separated by one space", () => {
    const line = formatRfc5424(event({ message: "hello world" }), {
      hostname: "h",
      procId: 1,
    })
    expect(line.endsWith(" hello world")).toBe(true)
  })

  it("escapes \\n in the message to literal `\\n`", () => {
    const line = formatRfc5424(event({ message: "line 1\nline 2" }), {
      hostname: "h",
      procId: 1,
    })
    expect(line).toContain("line 1\\nline 2")
    expect(line).not.toContain("\n") // no raw newline anywhere
  })

  it("escapes \\r and \\r\\n in the message", () => {
    const line = formatRfc5424(event({ message: "a\r\nb\rc" }), {
      hostname: "h",
      procId: 1,
    })
    expect(line).toContain("a\\nb\\rc")
  })

  it("preserves UTF-8 in the message", () => {
    const line = formatRfc5424(event({ message: "símbolos ✓ работа" }), {
      hostname: "h",
      procId: 1,
    })
    expect(line).toContain("símbolos ✓ работа")
  })

  it("handles empty message", () => {
    const line = formatRfc5424(event({ message: "" }), {
      hostname: "h",
      procId: 1,
    })
    expect(line.endsWith(" ")).toBe(true) // trailing space after SD
  })
})

describe("formatRfc5424 — full round-trip example", () => {
  it("matches the canonical session-trace shape", () => {
    const line = formatRfc5424(
      event({
        ts: Date.UTC(2026, 4, 20, 11, 14, 37, 412),
        severity: Severity.Warning,
        facility: Facility.User,
        source: "live-area.timeout",
        message: "invoke did not resolve in time; abort signal forwarded",
        structuredData: {
          slot: "quota-status/quota",
          "timeout-ms": 8000,
        },
      }),
      {
        hostname: "macbookpro.home.arpa",
        appName: "minimal-agent",
        procId: 87654,
      },
    )
    expect(line).toBe(
      '<12>1 2026-05-20T11:14:37.412Z macbookpro.home.arpa minimal-agent 87654 live-area.timeout [ma@local slot="quota-status/quota" timeout-ms="8000"] invoke did not resolve in time; abort signal forwarded',
    )
  })
})
