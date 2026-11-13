import { describe, expect, it } from "bun:test"
import { assertDecodableEncoding, parseSse } from "./sse-parser.ts"

function enc(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
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

describe("assertDecodableEncoding", () => {
  it("accepts an absent header", () => {
    expect(() => assertDecodableEncoding(null)).not.toThrow()
    expect(() => assertDecodableEncoding(undefined)).not.toThrow()
  })

  it("accepts identity", () => {
    expect(() => assertDecodableEncoding("identity")).not.toThrow()
    expect(() => assertDecodableEncoding("IDENTITY")).not.toThrow()
  })

  it("accepts gzip", () => {
    expect(() => assertDecodableEncoding("gzip")).not.toThrow()
    expect(() => assertDecodableEncoding("GZip")).not.toThrow()
  })

  it("accepts an identity/gzip list", () => {
    expect(() => assertDecodableEncoding("identity, gzip")).not.toThrow()
  })

  it("rejects brotli and names the encoding", () => {
    expect(() => assertDecodableEncoding("br")).toThrow(/sse_unsupported_content_encoding/)
    expect(() => assertDecodableEncoding("br")).toThrow(/"br"/)
  })

  it("rejects zstd and deflate, listing every offender", () => {
    expect(() => assertDecodableEncoding("zstd, deflate")).toThrow(/"zstd, deflate"/)
  })

  it("rejects br inside a list that also has gzip", () => {
    expect(() => assertDecodableEncoding("gzip, br")).toThrow(/"br"/)
  })

  it("tells the caller what to do", () => {
    expect(() => assertDecodableEncoding("zstd")).toThrow(/accept-encoding: gzip/)
  })
})

describe("parseSse content-encoding guard", () => {
  it("still parses a plain body when no encoding option is passed", async () => {
    const stream = streamFrom([enc('data: {"type":"ping"}\n\n')])
    expect(await collect(parseSse<{ type: string }>(stream))).toEqual([{ type: "ping" }])
  })

  it("parses a plain body declared identity", async () => {
    const stream = streamFrom([enc('data: {"type":"ping"}\n\n')])
    const result = await collect(
      parseSse<{ type: string }>(stream, { contentEncoding: "identity" }),
    )
    expect(result).toEqual([{ type: "ping" }])
  })

  it("parses a plain body declared with an absent header", async () => {
    const stream = streamFrom([enc('data: {"type":"ping"}\n\n')])
    const result = await collect(parseSse<{ type: string }>(stream, { contentEncoding: null }))
    expect(result).toEqual([{ type: "ping" }])
  })

  it("throws a named, actionable error for a body declared brotli instead of hanging", async () => {
    // Brotli magic-looking bytes: the old parser decoded these without error
    // and yielded zero events, which looked like a silent hang.
    const stream = streamFrom([new Uint8Array([0x1b, 0x9e, 0x00, 0x8f, 0x01, 0x00])])
    await expect(async () =>
      await collect(parseSse<unknown>(stream, { contentEncoding: "br" })),
    ).toThrow(/sse_unsupported_content_encoding.*"br"/)
  })

  it("throws for a real gzip body declared brotli, naming brotli", async () => {
    const gz = new Uint8Array(Bun.gzipSync(enc('data: {"type":"ping"}\n\n')))
    const stream = streamFrom([gz])
    await expect(async () =>
      await collect(parseSse<unknown>(stream, { contentEncoding: "br" })),
    ).toThrow(/"br"/)
  })

  it("inflates a gzip body declared gzip (http2 transport case)", async () => {
    const gz = new Uint8Array(Bun.gzipSync(enc('data: {"a":1}\n\ndata: {"a":2}\n\n')))
    // Split across chunks to prove the inflater streams.
    const stream = streamFrom([gz.slice(0, 5), gz.slice(5)])
    const result = await collect(parseSse<{ a: number }>(stream, { contentEncoding: "gzip" }))
    expect(result).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("passes through a body declared gzip that a transport already inflated", async () => {
    // Bun fetch auto-decompresses but keeps content-encoding: gzip. Re-inflating
    // that plaintext would throw, so the parser sniffs the magic bytes.
    const stream = streamFrom([enc('data: {"a":1}\n\n')])
    const result = await collect(parseSse<{ a: number }>(stream, { contentEncoding: "gzip" }))
    expect(result).toEqual([{ a: 1 }])
  })

  it("returns nothing from an empty body declared gzip", async () => {
    const stream = streamFrom([])
    const result = await collect(parseSse(stream, { contentEncoding: "gzip" }))
    expect(result).toEqual([])
  })
})
