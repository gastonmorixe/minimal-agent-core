import { describe, expect, it } from "bun:test"
import { parseSse } from "./sse-parser.ts"

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) out.push(item)
  return out
}

describe("parseSse", () => {
  it("parses a single data event into a JSON object", async () => {
    const stream = streamFrom([enc('data: {"type":"ping"}\n\n')])
    const result = await collect(parseSse<{ type: string }>(stream))
    expect(result).toEqual([{ type: "ping" }])
  })

  it("parses multiple events in one chunk", async () => {
    const stream = streamFrom([
      enc('data: {"seq":1}\n\ndata: {"seq":2}\n\ndata: {"seq":3}\n\n'),
    ])
    const result = await collect(parseSse<{ seq: number }>(stream))
    expect(result).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }])
  })

  it("handlines a line split across two reads", async () => {
    const stream = streamFrom([
      enc('data: {"lin'),
      enc('e":1}\n\n'),
    ])
    const result = await collect(parseSse<{ line: number }>(stream))
    expect(result).toEqual([{ line: 1 }])
  })

  it("handles an event spread across many tiny chunks", async () => {
    const stream = streamFrom([
      enc("d"),
      enc("ata"),
      enc(": "),
      enc('{"c":1}'),
      enc("\n"),
      enc("\n"),
    ])
    const result = await collect(parseSse<{ c: number }>(stream))
    expect(result).toEqual([{ c: 1 }])
  })

  it("stops at data: [DONE] and yields nothing after", async () => {
    const stream = streamFrom([
      enc('data: {"msg":"first"}\n\ndata: [DONE]\n\ndata: {"msg":"after"}\n\n'),
    ])
    const result = await collect(parseSse<{ msg: string }>(stream))
    expect(result).toEqual([{ msg: "first" }])
  })

  it("stops at data: [DONE] as the very first event", async () => {
    const stream = streamFrom([enc("data: [DONE]\n\n")])
    const result = await collect(parseSse(stream))
    expect(result).toEqual([])
  })

  it("skips event: lines, empty lines, and comments", async () => {
    const stream = streamFrom([
      enc("event: ping\ndata: {\"ok\":true}\n\n:comment\nevent: done\n\n"),
    ])
    const result = await collect(parseSse<{ ok: boolean }>(stream))
    expect(result).toEqual([{ ok: true }])
  })

  it("skips malformed data JSON without crashing", async () => {
    const stream = streamFrom([
      enc('data: {bad}\n\ndata: {"good":1}\n\ndata: not-json\n\n'),
    ])
    const result = await collect(parseSse<{ good?: number }>(stream))
    expect(result).toEqual([{ good: 1 }])
  })

  it("skips data lines with no value", async () => {
    const stream = streamFrom([enc('data:\n\ndata: {"x":1}\n\n')])
    const result = await collect(parseSse<{ x: number }>(stream))
    expect(result).toEqual([{ x: 1 }])
  })

  it("returns nothing from an empty stream", async () => {
    const stream = streamFrom([enc("")])
    const result = await collect(parseSse(stream))
    expect(result).toEqual([])
  })

  it("throws when buffer exceeds the max length", async () => {
    // Build a line well past 5 MB so it exceeds MAX_BUFFER_LENGTH
    // before the newline is reached.
    const buf = new Uint8Array(6 * 1024 * 1024)
    buf.fill(65) // fill with 'A'
    // Don't append a newline — the parser's line-buffer keeps growing
    const stream = streamFrom([buf])
    await expect(
      async () => await collect(parseSse(stream)),
    ).toThrow(/SSE line exceeded maximum length/)
  })
})
