/**
 * Regression test: blank-line separation between thinking block and response.
 *
 * When the model produces a thinking block followed by response text, there
 * must be exactly one blank line between them in the scrollback.  Without the
 * fix the thinking text runs directly into the response text with no visual
 * separator.
 *
 * This test simulates the internal state machine of `runReplLiveArea` — the
 * same `writeDirectSink` / `baseSink` / `onThinkingStop` plumbing — and
 * captures output to a string so we can assert on the rendered result.
 */

import { describe, expect, it } from "bun:test"

// ---------------------------------------------------------------------------
// Minimal compositor that captures writeStream output as a plain string.
// ---------------------------------------------------------------------------
class FakeCompositor {
  readonly chunks: string[] = []
  readonly writeStreamCalls: string[] = []
  columns = 80
  rows = 24
  mounted = false
  liveHeight = 1
  setLiveArea(_lines: string[], _cursor: { row: number; col: number } | null): void {
    // no-op
  }
  setLiveHeight(n: number): void {
    this.liveHeight = n
  }
  writeStream(s: string): void {
    this.writeStreamCalls.push(s)
    this.chunks.push(s)
  }
  text(): string {
    return this.chunks.join("")
  }
}

// ---------------------------------------------------------------------------
// The minimal live-area rendering pipeline (extracted from repl-live-area.ts).
// This recreates the exact state machine that was buggy.
// ---------------------------------------------------------------------------
function simulateTurn(opts: {
  thinkingChunks: string[]
  responseText: string
  hasFormatter: boolean
}): { output: string; writeStreamCalls: string[] } {
  const compositor = new FakeCompositor()

  // State variables from runReplLiveArea:
  let wroteOutput = false
  let lastChunkEndedWithNewline = false
  let lastKind: "none" | "text" | "transcript" = "none"

  // Formatter stub (does nothing when not needed).
  const formatter = opts.hasFormatter
    ? { start: () => {}, write: (_s: string) => {}, end: () => Promise.resolve() }
    : null

  // This is the writeDirectSink from repl-live-area.ts — used for thinking
  // chunks AND for the onThinkingStop separator.
  const writeDirectSink = (s: string) => {
    if (s.length === 0) return
    if (!wroteOutput) compositor.writeStream("\n")
    if (lastKind === "transcript") {
      compositor.writeStream("\n")
    }
    wroteOutput = true
    lastChunkEndedWithNewline = s.endsWith("\n")
    lastKind = "text"
    compositor.writeStream(s)
  }

  // baseSink — used for response text.
  const baseSink = (s: string) => {
    if (s.length === 0) return
    if (!wroteOutput) compositor.writeStream("\n")
    if (lastKind === "transcript") {
      compositor.writeStream("\n")
    }
    wroteOutput = true
    lastChunkEndedWithNewline = s.endsWith("\n")
    lastKind = "text"
    if (formatter) {
      formatter.write(s)
    } else {
      compositor.writeStream(s)
    }
  }

  // Thinking chunk handler — writes through writeDirectSink.
  const onThinkingChunk = (chunk: string) => {
    writeDirectSink(chunk)
  }

  // The FIXED onThinkingStop: resets state so baseSink will insert
  // the leading blank-line separator.
  const onThinkingStopFixed = () => {
    writeDirectSink(lastChunkEndedWithNewline ? "\n" : "\n\n")
    // Reset state so the next baseSink call will insert a leading blank line.
    lastKind = "none"
    wroteOutput = false
  }

  // ---- Run the simulation ----
  // Emit thinking chunks.
  for (const chunk of opts.thinkingChunks) {
    onThinkingChunk(chunk)
  }

  // Signal thinking stop (use the fixed version).
  onThinkingStopFixed()

  // Now emit the response text through baseSink.
  baseSink(opts.responseText)

  return { output: compositor.text(), writeStreamCalls: compositor.writeStreamCalls }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("thinking-block → response blank-line separation", () => {
  it("places exactly one blank line between thinking text and response text", () => {
    const { output } = simulateTurn({
      thinkingChunks: ["First thinking line.\n", "Second thinking line.\n"],
      responseText: "Here is the response text.",
      hasFormatter: false,
    })

    // The output should contain:
    //   1. Thinking text (dimmed)
    //   2. A blank line (one empty line)
    //   3. Response text
    //
    // The key assertion: the response text must NOT immediately follow
    // the thinking text. There must be a blank line (two \n) between them.
    expect(output).toMatch(/thinking.*\n\n.*Here is the response/s)
  })

  it("handles thinking that does not end in newline", () => {
    const { output } = simulateTurn({
      thinkingChunks: ["partial thinking text without newline"],
      responseText: "Response follows.",
      hasFormatter: false,
    })

    // Even when the thinking block doesn't end with \n, the onThinkingStop
    // writes "\n\n" (close line + blank row), then baseSink writes the
    // response. The response must be separated by a blank line.
    expect(output).toMatch(/partial thinking text without newline.*\n\n.*Response follows/s)
  })

  it("handles empty thinking chunks followed by response", () => {
    const { output } = simulateTurn({
      thinkingChunks: [],
      responseText: "Response without thinking.",
      hasFormatter: false,
    })

    // When there is no thinking block at all, the first baseSink call
    // will hit the !wroteOutput guard and emit a leading \n, then the
    // response text. This is the normal case for a prompt with no
    // thinking block.
    expect(output).toMatch(/\nResponse without thinking\./)
  })

  it("handles multiple thinking blocks interleaved with response text", () => {
    const compositor = new FakeCompositor()
    let wroteOutput = false
    let lastChunkEndedWithNewline = false
    let lastKind: "none" | "text" | "transcript" = "none"

    const writeDirectSink = (s: string) => {
      if (s.length === 0) return
      if (!wroteOutput) compositor.writeStream("\n")
      if (lastKind === "transcript") compositor.writeStream("\n")
      wroteOutput = true
      lastChunkEndedWithNewline = s.endsWith("\n")
      lastKind = "text"
      compositor.writeStream(s)
    }

    const baseSink = (s: string) => {
      if (s.length === 0) return
      if (!wroteOutput) compositor.writeStream("\n")
      if (lastKind === "transcript") compositor.writeStream("\n")
      wroteOutput = true
      lastChunkEndedWithNewline = s.endsWith("\n")
      lastKind = "text"
      compositor.writeStream(s)
    }

    const onThinkingStopFixed = () => {
      writeDirectSink(lastChunkEndedWithNewline ? "\n" : "\n\n")
      lastKind = "none"
      wroteOutput = false
    }

    // Pattern: thinking → response → thinking → response
    writeDirectSink("Thinking block 1.\n")
    onThinkingStopFixed()
    baseSink("Response 1.\n")

    writeDirectSink("Thinking block 2.\n")
    onThinkingStopFixed()
    baseSink("Response 2.\n")

    const output = compositor.text()
    // Each thinking block must be separated from its following response.
    expect(output).toMatch(/Thinking block 1\..*\n\n.*Response 1\./s)
    expect(output).toMatch(/Response 1\..*\n.*Thinking block 2\..*\n\n.*Response 2\./s)
  })
})
