import { describe, expect, it } from "bun:test"

import { BoundedDrainError, consumeStreamBounded } from "./bounded-drain.ts"

/** Helper: build a ReadableStream from one or more Uint8Array chunks. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/** Helper: encode a string as Uint8Array. */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

describe("consumeStreamBounded", () => {
  it("returns the full decoded text when content is under the byte limit", async () => {
    const stream = streamOf(enc("hello, world"))
    const result = await consumeStreamBounded(stream, 1024)
    expect(result).toBe("hello, world")
  })

  it("handles content at exactly the byte limit", async () => {
    const payload = "a".repeat(100)
    const stream = streamOf(enc(payload))
    const result = await consumeStreamBounded(stream, 100)
    expect(result).toBe(payload)
    expect(result.length).toBe(100)
  })

  it("throws BoundedDrainError when content exceeds the byte limit", async () => {
    const stream = streamOf(enc("this is too long for the buffer"))
    expect(consumeStreamBounded(stream, 5)).rejects.toThrow(BoundedDrainError)
  })

  it("includes the limit and actual size in the error message", async () => {
    const stream = streamOf(enc("123456"))
    try {
      await consumeStreamBounded(stream, 3)
      // unreachable
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(BoundedDrainError)
      expect((e as BoundedDrainError).message).toMatch(/3/)
    }
  })

  it("returns empty string for an empty stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const result = await consumeStreamBounded(stream, 1024)
    expect(result).toBe("")
  })

  it("accumulates content split across multiple chunks", async () => {
    const stream = streamOf(enc("one "), enc("two "), enc("three"))
    const result = await consumeStreamBounded(stream, 1024)
    expect(result).toBe("one two three")
  })

  it("rejects with BoundedDrainError on the chunk that pushes over the limit (multi-chunk)", async () => {
    const stream = streamOf(enc("aaaa"), enc("bbbb"))
    // 4 bytes under limit, 8 bytes total — second chunk caps it
    try {
      await consumeStreamBounded(stream, 6)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(BoundedDrainError)
    }
  })

  it("handles single-byte chunks without excessive overhead", async () => {
    const chars: Uint8Array[] = []
    for (let i = 0; i < 50; i++) chars.push(enc("x"))
    const stream = streamOf(...chars)
    const result = await consumeStreamBounded(stream, 100)
    expect(result).toBe("x".repeat(50))
    expect(result.length).toBe(50)
  })

  it("uses the supplied TextDecoder when one is passed", async () => {
    const uppercase = new TextDecoder("utf-8") // same encoder, just verify pass-through
    const stream = streamOf(enc("hello"))
    const result = await consumeStreamBounded(stream, 1024, uppercase)
    expect(result).toBe("hello")
  })

  it("propagates a reader error instead of swallowing it", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc("ok"))
        controller.error(new Error("stream blew up"))
      },
    })
    await expect(consumeStreamBounded(stream, 1024)).rejects.toThrow("stream blew up")
  })

  it("releases the reader lock even when an error is thrown mid-stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc("data"))
        controller.error(new Error("kaboom"))
      },
    })
    try {
      await consumeStreamBounded(stream, 1024)
    } catch {
      // expected
    }
    // The reader lock must have been released so a new reader can be acquired.
    const reader = stream.getReader()
    reader.releaseLock()
  })

  it("throws BoundedDrainError for a single chunk that alone exceeds the limit", async () => {
    const big = "x".repeat(10_000)
    const stream = streamOf(enc(big))
    await expect(consumeStreamBounded(stream, 100)).rejects.toThrow(BoundedDrainError)
  })
})
