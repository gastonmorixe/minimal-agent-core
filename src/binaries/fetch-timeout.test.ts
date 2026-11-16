import { describe, expect, it } from "bun:test"

import {
  isTimeoutError,
  readWithIdleTimeout,
  timeoutDetail,
  timeoutError,
  withTimeout,
} from "./fetch-timeout.ts"

describe("fetch-timeout helpers", () => {
  it("timeoutError is named TimeoutError and keeps the message verbatim", () => {
    const e = timeoutError("x timed out after 5 ms")
    expect(e.name).toBe("TimeoutError")
    expect(e.message).toBe("x timed out after 5 ms")
    expect(isTimeoutError(e)).toBe(true)
    expect(isTimeoutError(new Error("nope"))).toBe(false)
    expect(isTimeoutError(new DOMException("t", "TimeoutError"))).toBe(true)
  })

  it("timeoutDetail does not double-prefix our own message and maps foreign ones", () => {
    expect(timeoutDetail(timeoutError("dl timed out after 5 ms"), "dl")).toBe(
      "dl timed out after 5 ms",
    )
    expect(timeoutDetail(new DOMException("The operation timed out.", "TimeoutError"), "dl")).toBe(
      "dl timed out",
    )
  })

  it("withTimeout aborts the signal it hands out with a TimeoutError reason", async () => {
    let seen: AbortSignal | undefined
    await expect(
      withTimeout(
        (s) => {
          seen = s
          return new Promise<never>(() => {})
        },
        10,
        "op timed out after 10 ms",
      ),
    ).rejects.toThrow("op timed out after 10 ms")
    expect(seen?.aborted).toBe(true)
    expect((seen?.reason as Error | undefined)?.name).toBe("TimeoutError")
  })

  it("withTimeout clears its timer on success (signal stays un-aborted)", async () => {
    let seen: AbortSignal | undefined
    const v = await withTimeout(
      async (s) => {
        seen = s
        return 7
      },
      10,
      "m",
    )
    await Bun.sleep(40)
    expect(v).toBe(7)
    expect(seen?.aborted).toBe(false)
  })

  it("withTimeout combines an outer signal via AbortSignal.any", async () => {
    const outer = new AbortController()
    let seen: AbortSignal | undefined
    const p = withTimeout(
      (s) => {
        seen = s
        return new Promise<never>(() => {})
      },
      5_000,
      "m",
      outer.signal,
    )
    outer.abort(new Error("cancelled"))
    await expect(p).rejects.toThrow("cancelled")
    expect(seen?.aborted).toBe(true)
  })

  it("readWithIdleTimeout rejects a stalled read and cancels the stream", async () => {
    let cancelReason: unknown
    const reader = new ReadableStream<Uint8Array>({
      cancel(r) {
        cancelReason = r
      },
    }).getReader()
    await expect(readWithIdleTimeout(reader, 10, "idle 10 ms")).rejects.toThrow("idle 10 ms")
    expect(isTimeoutError(cancelReason)).toBe(true)
  })

  it("readWithIdleTimeout resets per chunk: each read gets a fresh window", async () => {
    const reader = new ReadableStream<Uint8Array>({
      async pull(c) {
        await Bun.sleep(15)
        c.enqueue(new Uint8Array(1))
      },
    }).getReader()
    // 6 reads x 15 ms = 90 ms total, far above the 40 ms idle window.
    for (let i = 0; i < 6; i++) {
      const r = await readWithIdleTimeout(reader, 40, "idle")
      expect(r.done).toBe(false)
    }
    await reader.cancel()
  })
})
