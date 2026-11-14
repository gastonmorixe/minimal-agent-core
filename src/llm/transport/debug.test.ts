import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { getDiagnosticBus, type LogEvent, Severity } from "../../bus/diagnostic-bus.ts"

import { debugRequestOptions, MAX_LINE_ROWS, requestDumpLines, requestDumpRows } from "./debug.ts"
import type { SendOptions } from "./types.ts"

const REQUEST = {
  model: "test-model",
  maxTokens: 100,
  messages: [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    },
  ],
  system: [{ type: "text", text: "system text", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "Read", description: "read a file" }],
  auth: { kind: "api-key", key: "sk-secret-value" },
} as unknown as SendOptions

describe("requestDumpLines", () => {
  it("renders the header and the body preview as plain text", () => {
    expect(requestDumpLines(REQUEST)).toEqual([
      "--- POST test-model ---",
      "  model: test-model",
      "  stream: true",
      "  max_tokens: 100",
      "  request_type: conversation",
      "  Body:",
      "    system: [1 block(s)]",
      "      block 0 [cached]: system text",
      "    tools: [1 tool(s)]",
      "      Read: read a file",
      "    messages: [2 message(s)]",
      "      user: hello",
      '      assistant [← cached prefix ends here]: "hi"',
    ])
  })

  it("has no ANSI escapes and never includes the credential", () => {
    const text = requestDumpLines(REQUEST).join("\n")
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain("sk-secret-value")
  })

  // Regression: a multi-line system block (the real instructions prompt) put
  // raw newlines inside one row. The host's line-anchored `^ {6}` row regex
  // could not match it, so `system: [4 block(s)]` rendered only `block 0` and
  // the other three vanished. Every row must be exactly one line.
  it("keeps every row on a single line even when the source text is multi-line", () => {
    const multi = {
      ...REQUEST,
      system: [
        { type: "text", text: "identity" },
        { type: "text", text: "# Instructions\n\n- Be concise.\n- Be direct." },
        { type: "text", text: "# Tools\n\nPrefer dedicated tools." },
        { type: "text", text: "# Safety\n\nCheckpoint every 50 rounds." },
      ],
    } as unknown as SendOptions

    const lines = requestDumpLines(multi)
    expect(lines.filter((l) => l.includes("\n"))).toEqual([])

    const blocks = lines.filter((l) => /^ {6}block \d/.test(l))
    expect(blocks).toHaveLength(4)
    // The single-line block keeps its text as-is; the three multi-line ones
    // show the collapsed boundaries instead of losing their content.
    expect(blocks[0]).toBe("      block 0: identity")
    expect(blocks.slice(1).every((l) => l.includes("⏎"))).toBe(true)
  })

  it("marks the newlines it collapses so the block structure stays legible", () => {
    const multi = {
      ...REQUEST,
      system: [{ type: "text", text: "line one\nline two" }],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    } as unknown as SendOptions
    const row = requestDumpLines(multi).find((l) => l.includes("block 0")) ?? ""
    expect(row).toBe("      block 0: line one ⏎ line two")
  })

  // `--verbose` used to be a no-op in the dump: `truncate()` re-checked the
  // global env and ignored the cap argument, so previews stayed cut.
  it("emits a full continuation row when a preview is capped, and none when verbose", () => {
    const long = "x".repeat(300)
    const req = {
      ...REQUEST,
      tools: [{ name: "Mode", description: long }],
      messages: [{ role: "user", content: "hi" }],
      system: [],
    } as unknown as SendOptions

    const capped = requestDumpLines(req, false)
    const rowIndex = capped.findIndex((l) => l.startsWith("      Mode: "))
    expect(capped[rowIndex]).toContain("...(+")
    // The untruncated text follows on its own label-free row.
    expect(capped[rowIndex + 1]).toBe(`        ${long}`)

    // Contract change (verbose request dump plan): verbose adds one `line`
    // row per source line, so the long text sits in 2 rows: the labelled
    // row and its `line` row. No row carries the truncation hint.
    const verbose = requestDumpLines(req, true)
    expect(verbose.some((l) => l.includes("...(+"))).toBe(false)
    const rows = requestDumpRows(req, true).filter((r) => r.text.includes(long))
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.text.startsWith("      Mode: "))).toHaveLength(1)
    expect(rows.filter((r) => r.data?.kind === "line" && r.text === long)).toHaveLength(1)
  })
})

describe("requestDumpRows (verbose)", () => {
  const lineRows = (rows: ReturnType<typeof requestDumpRows>) =>
    rows.filter((r) => r.data?.kind === "line")

  it("verbose: one line row per source line, indentation kept", () => {
    const req = {
      ...REQUEST,
      messages: [],
      system: [{ type: "text", text: "a\n  b\n\nc" }],
      tools: [],
    } as unknown as SendOptions
    const rows = lineRows(requestDumpRows(req, true))
    expect(rows.map((r) => r.text)).toEqual(["a", "  b", "", "c"])
    expect(rows.map((r) => r.data?.line)).toEqual([1, 2, 3, 4])
    expect(rows.every((r) => r.data?.section === "system" && r.data?.part === 0)).toBe(true)
  })

  it("verbose: labelled rows carry kind part, and lines follow their part", () => {
    const rows = requestDumpRows(REQUEST, true)
    const parts = rows.filter((r) => r.data?.kind === "part")
    expect(parts.map((r) => [r.data?.section, r.data?.part])).toEqual([
      ["system", 0],
      ["tools", 0],
      ["messages", 0],
      ["messages", 1],
    ])
    const sysPart = rows.findIndex((r) => r.data?.kind === "part" && r.data.section === "system")
    expect(rows[sysPart + 1]).toEqual({
      text: "system text",
      data: { kind: "line", section: "system", part: 0, line: 1 },
    })
  })

  it("verbose: no row contains a newline", () => {
    const req = {
      ...REQUEST,
      messages: [
        { role: "user", content: "one\ntwo\n  three" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t1\nt2", signature: "s" },
            { type: "text", text: "x\ny" },
            { type: "tool_use", id: "toolu_abc123", name: "Bash", input: { command: "ls\n-la" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc123",
              content: [{ type: "text", text: "r1\nr2" }],
            },
          ],
        },
      ],
      system: [{ type: "text", text: "# H\n\n- a\n- b" }],
      tools: [{ name: "Read", description: "line 1\nline 2" }],
    } as unknown as SendOptions
    const rows = requestDumpRows(req, true)
    expect(rows.filter((r) => r.text.includes("\n"))).toEqual([])
    // The line rows hold the faithful text: the tool_use input is pretty JSON.
    const lines = lineRows(rows).map((r) => r.text)
    expect(lines).toContain('  "command": "ls\\n-la"')
    expect(lines).toContain("  three")
    expect(lines).toContain("r2")
    expect(lines).toContain("line 2")
    // Line numbers count through the whole part (message 1 has 3 blocks).
    const msg1 = lineRows(rows).filter((r) => r.data?.section === "messages" && r.data.part === 1)
    expect(msg1.map((r) => r.data?.line)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(msg1.map((r) => r.data?.block)).toEqual([0, 0, 1, 1, 2, 2, 2])
  })

  it("verbose: block rows carry tool ids", () => {
    const req = {
      ...REQUEST,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_a1b2c3", name: "Bash", input: { c: 1 } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a1b2c3", content: "ok", is_error: true },
          ],
        },
      ],
      system: [],
      tools: [],
    } as unknown as SendOptions
    const blocks = requestDumpRows(req, true).filter((r) => r.data?.kind === "block")
    expect(blocks).toEqual([
      {
        text: "        block 0 tool_use",
        data: {
          kind: "block",
          section: "messages",
          part: 0,
          block: 0,
          blockType: "tool_use",
          toolUseId: "toolu_a1b2c3",
          toolName: "Bash",
        },
      },
      {
        text: "        block 0 tool_result",
        data: {
          kind: "block",
          section: "messages",
          part: 1,
          block: 0,
          blockType: "tool_result",
          toolUseId: "toolu_a1b2c3",
          isError: true,
        },
      },
    ])
  })

  // F1: the dump runs inside the send path (`canonical-send.ts`), so a tool
  // input that `JSON.stringify` rejects must not abort the request.
  it("verbose: a cyclic tool input produces a row instead of throwing", () => {
    const cyclic: Record<string, unknown> = { command: "ls" }
    cyclic.self = cyclic
    const req = {
      ...REQUEST,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_cyc001", name: "Bash", input: cyclic }],
        },
      ],
      system: [],
      tools: [],
    } as unknown as SendOptions

    let rows: ReturnType<typeof requestDumpRows> = []
    expect(() => {
      rows = requestDumpRows(req, true)
    }).not.toThrow()
    expect(rows.length).toBeGreaterThan(0)
    expect(lineRows(rows).map((r) => r.text)).toContain('  "self": "[Circular]"')
  })

  it("verbose: a BigInt tool input produces a row instead of throwing", () => {
    const req = {
      ...REQUEST,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_big001",
              name: "Bash",
              input: { bytes: 9007199254740993n },
            },
          ],
        },
      ],
      system: [],
      tools: [],
    } as unknown as SendOptions

    let rows: ReturnType<typeof requestDumpRows> = []
    expect(() => {
      rows = requestDumpRows(req, true)
    }).not.toThrow()
    expect(lineRows(rows).map((r) => r.text)).toContain('  "bytes": "9007199254740993n"')
  })

  // F2: an unbounded split made one bus event plus one synchronous file append
  // per source line (a 5000-line tool_result gave 5010 rows).
  it("verbose: a huge block stops at MAX_LINE_ROWS and reports the hidden count", () => {
    const total = 5000
    const text = Array.from({ length: total }, (_, i) => `l${i + 1}`).join("\n")
    const req = {
      ...REQUEST,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_big", content: text }],
        },
      ],
      system: [],
      tools: [],
    } as unknown as SendOptions

    const rows = requestDumpRows(req, true).filter((r) => r.data?.kind === "line")
    // The cap still holds: exactly MAX_LINE_ROWS source lines, no more.
    expect(rows.length).toBe(MAX_LINE_ROWS)

    // The elision is DATA: a typed row that carries the count, never a string.
    const elided = requestDumpRows(req, true).filter((r) => r.data?.kind === "elided")
    expect(elided).toHaveLength(1)
    expect(elided[0].data?.hiddenLines).toBe(total - MAX_LINE_ROWS)
    expect(elided[0].text).toBe("")

    // Core composes no truncation hint for this path.
    const dump = requestDumpRows(req, true)
    expect(dump.filter((r) => r.text.includes("...(+")).map((r) => r.text)).toEqual([])
  })

  it("non-verbose rows and data are unchanged", () => {
    const rows = requestDumpRows(REQUEST, false)
    expect(rows.every((r) => r.data === undefined)).toBe(true)
    expect(rows.map((r) => r.text)).toEqual(requestDumpLines(REQUEST, false))
    expect(requestDumpLines(REQUEST, false)).toEqual([
      "--- POST test-model ---",
      "  model: test-model",
      "  stream: true",
      "  max_tokens: 100",
      "  request_type: conversation",
      "  Body:",
      "    system: [1 block(s)]",
      "      block 0 [cached]: system text",
      "    tools: [1 tool(s)]",
      "      Read: read a file",
      "    messages: [2 message(s)]",
      "      user: hello",
      '      assistant [← cached prefix ends here]: "hi"',
    ])
  })
})

describe("debugRequestOptions", () => {
  const previous = process.env.DEBUG
  let events: LogEvent[] = []
  let off: () => void = () => {}

  beforeEach(() => {
    events = []
    off = getDiagnosticBus().on("*", (e) => events.push(e))
  })

  afterEach(() => {
    off()
    if (previous === undefined) delete process.env.DEBUG
    else process.env.DEBUG = previous
  })

  it("emits one Debug diagnostic per dump line when DEBUG is set", () => {
    process.env.DEBUG = "1"
    debugRequestOptions(REQUEST)
    expect(events.map((e) => e.message)).toEqual(requestDumpLines(REQUEST))
    expect(events.every((e) => e.severity === Severity.Debug)).toBe(true)
    expect(events.every((e) => e.source === "transport.request-dump")).toBe(true)
  })

  it("debugRequestOptions spreads row data", () => {
    const previousVerbose = process.env.VERBOSE
    process.env.DEBUG = "1"
    process.env.VERBOSE = "1"
    try {
      debugRequestOptions(REQUEST)
    } finally {
      if (previousVerbose === undefined) delete process.env.VERBOSE
      else process.env.VERBOSE = previousVerbose
    }
    const rows = requestDumpRows(REQUEST, true)
    expect(events.map((e) => e.message)).toEqual(rows.map((r) => r.text))
    const isMsgLine = (d: { kind?: unknown; section?: unknown } | undefined): boolean =>
      d?.kind === "line" && d.section === "messages"
    const line = events.find((e) => isMsgLine(e.structuredData))
    expect(line?.structuredData).toEqual({
      row: rows.findIndex((r) => isMsgLine(r.data)),
      kind: "line",
      section: "messages",
      part: 0,
      block: 0,
      line: 1,
    })
    expect(events[0].structuredData).toEqual({ row: 0 })
    expect(events[events.length - 1].structuredData?.last).toBe(true)
  })

  it("keeps non-verbose structured data to row and last", () => {
    const previousVerbose = process.env.VERBOSE
    process.env.DEBUG = "1"
    delete process.env.VERBOSE
    try {
      debugRequestOptions(REQUEST)
    } finally {
      if (previousVerbose !== undefined) process.env.VERBOSE = previousVerbose
    }
    const keys = new Set(events.flatMap((e) => Object.keys(e.structuredData ?? {})))
    expect([...keys].sort()).toEqual(["last", "row"])
  })

  it("emits nothing when DEBUG is unset", () => {
    delete process.env.DEBUG
    debugRequestOptions(REQUEST)
    expect(events).toEqual([])
  })
})
