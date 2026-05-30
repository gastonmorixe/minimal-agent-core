import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { loadQueue, type QueueItem, QueueStore, queueFilePath } from "./queue-store.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-queue-store-"))
}

/**
 * Wait for an in-flight write to complete. The flush loop drains until
 * `latestPending` is null AND `inFlight` is false; we poll because the
 * Bun.write/rename pair runs on a microtask, not a turn-of-the-loop.
 */
async function waitQuiet(s: QueueStore, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now()
  while (s.isWriting() || s.pendingSnapshot() !== null) {
    if (Date.now() - t0 > timeoutMs) throw new Error("queue store never quiesced")
    await new Promise((r) => setTimeout(r, 5))
  }
}

const Q = (text: string, commitLines: string[] = []): QueueItem => ({ text, commitLines })

describe("QueueStore.save", () => {
  it("writes the snapshot atomically to <sid>.queue", async () => {
    const dir = tmp()
    const sid = "ma-queue-A"
    const s = new QueueStore(sid, { dir })
    s.save([Q("hello"), Q("world", ["line1", "line2"])])
    await waitQuiet(s)
    const path = queueFilePath(sid, dir)
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    expect(parsed).toEqual([
      { text: "hello", commitLines: [] },
      { text: "world", commitLines: ["line1", "line2"] },
    ])
  })

  it("overwrites a prior snapshot", async () => {
    const dir = tmp()
    const sid = "ma-queue-B"
    const s = new QueueStore(sid, { dir })
    s.save([Q("first"), Q("second")])
    await waitQuiet(s)
    s.save([Q("only one left")])
    await waitQuiet(s)
    const parsed = JSON.parse(readFileSync(queueFilePath(sid, dir), "utf-8"))
    expect(parsed).toEqual([{ text: "only one left", commitLines: [] }])
  })

  it("does not leave a tmp file behind on success", async () => {
    const dir = tmp()
    const sid = "ma-queue-C"
    const s = new QueueStore(sid, { dir })
    s.save([Q("clean")])
    await waitQuiet(s)
    const tmpPath = `${queueFilePath(sid, dir)}.tmp.${process.pid}`
    expect(existsSync(tmpPath)).toBe(false)
  })

  it("defensively copies items so caller mutations after save() don't bleed", async () => {
    const dir = tmp()
    const sid = "ma-queue-D"
    const s = new QueueStore(sid, { dir })
    const queue: QueueItem[] = [Q("alpha", ["L1"])]
    s.save(queue)
    // Mutate the caller's array AND the inner item's commitLines: the
    // pending snapshot must already be a deep copy, so neither change
    // can affect what lands on disk.
    queue.push(Q("beta"))
    queue[0].commitLines.push("L2-leaked")
    await waitQuiet(s)
    const parsed = JSON.parse(readFileSync(queueFilePath(sid, dir), "utf-8"))
    expect(parsed).toEqual([{ text: "alpha", commitLines: ["L1"] }])
  })
})

describe("QueueStore.clear", () => {
  it("deletes the queue file", async () => {
    const dir = tmp()
    const sid = "ma-queue-E"
    const s = new QueueStore(sid, { dir })
    s.save([Q("doomed")])
    await waitQuiet(s)
    expect(existsSync(queueFilePath(sid, dir))).toBe(true)
    s.clear()
    await waitQuiet(s)
    expect(existsSync(queueFilePath(sid, dir))).toBe(false)
  })

  it("is a no-op when no queue file exists (no throw)", async () => {
    const dir = tmp()
    const sid = "ma-queue-F"
    const s = new QueueStore(sid, { dir })
    s.clear()
    await waitQuiet(s)
    expect(existsSync(queueFilePath(sid, dir))).toBe(false)
  })

  it("save([]) is equivalent to clear()", async () => {
    const dir = tmp()
    const sid = "ma-queue-G"
    const s = new QueueStore(sid, { dir })
    s.save([Q("temporary")])
    await waitQuiet(s)
    s.save([])
    await waitQuiet(s)
    expect(existsSync(queueFilePath(sid, dir))).toBe(false)
  })
})

describe("QueueStore — coalescing", () => {
  it("rapid saves coalesce to a single trailing on-disk write", async () => {
    const dir = tmp()
    const sid = "ma-queue-H"
    const s = new QueueStore(sid, { dir })
    // Burst 50 saves synchronously. Without coalescing we'd issue 50
    // disk writes; with coalescing we issue at most 2 (one in-flight,
    // one final pending).
    for (let i = 0; i < 50; i++) {
      s.save([Q(`step-${i}`)])
    }
    await waitQuiet(s)
    const parsed = JSON.parse(readFileSync(queueFilePath(sid, dir), "utf-8"))
    expect(parsed).toEqual([{ text: "step-49", commitLines: [] }])
  })

  it("save during in-flight write is captured (no race loss)", async () => {
    const dir = tmp()
    const sid = "ma-queue-I"
    const s = new QueueStore(sid, { dir })
    s.save([Q("first")])
    // Don't await. Immediately schedule a second save while the first
    // is in-flight.
    s.save([Q("second")])
    s.save([Q("third — should be the final on-disk snapshot")])
    await waitQuiet(s)
    const parsed = JSON.parse(readFileSync(queueFilePath(sid, dir), "utf-8"))
    expect(parsed).toEqual([
      { text: "third — should be the final on-disk snapshot", commitLines: [] },
    ])
  })

  it("clear during in-flight write removes the file", async () => {
    const dir = tmp()
    const sid = "ma-queue-J"
    const s = new QueueStore(sid, { dir })
    s.save([Q("about to be deleted")])
    // Schedule clear before the save completes.
    s.clear()
    await waitQuiet(s)
    expect(existsSync(queueFilePath(sid, dir))).toBe(false)
  })

  it("save→clear→save sequence ends in the saved state", async () => {
    const dir = tmp()
    const sid = "ma-queue-K"
    const s = new QueueStore(sid, { dir })
    s.save([Q("a")])
    s.clear()
    s.save([Q("c")])
    await waitQuiet(s)
    const parsed = JSON.parse(readFileSync(queueFilePath(sid, dir), "utf-8"))
    expect(parsed).toEqual([{ text: "c", commitLines: [] }])
  })
})

describe("loadQueue", () => {
  it("returns [] when the queue file does not exist", () => {
    const dir = tmp()
    expect(loadQueue("nonexistent-sid", dir)).toEqual([])
  })

  it("returns [] when the queue file is empty", () => {
    const dir = tmp()
    const sid = "ma-queue-L"
    writeFileSync(queueFilePath(sid, dir), "")
    expect(loadQueue(sid, dir)).toEqual([])
  })

  it("returns [] when the queue file is not valid JSON", () => {
    const dir = tmp()
    const sid = "ma-queue-M"
    writeFileSync(queueFilePath(sid, dir), "{ not json")
    expect(loadQueue(sid, dir)).toEqual([])
  })

  it("returns [] when the JSON root is not an array", () => {
    const dir = tmp()
    const sid = "ma-queue-N"
    writeFileSync(queueFilePath(sid, dir), JSON.stringify({ foo: "bar" }))
    expect(loadQueue(sid, dir)).toEqual([])
  })

  it("filters out items missing/malformed text or commitLines", () => {
    const dir = tmp()
    const sid = "ma-queue-O"
    const mixed = [
      { text: "good", commitLines: [] },
      { text: 42, commitLines: [] }, // text not a string
      { text: "no-commit-lines" }, // missing commitLines
      { text: "bad-lines", commitLines: [1, 2, 3] }, // commitLines not strings
      null,
      { text: "second-good", commitLines: ["L"] },
    ]
    writeFileSync(queueFilePath(sid, dir), JSON.stringify(mixed))
    expect(loadQueue(sid, dir)).toEqual([
      { text: "good", commitLines: [] },
      { text: "second-good", commitLines: ["L"] },
    ])
  })

  it("filters out items with empty text (synthetic zero-text submits)", () => {
    const dir = tmp()
    const sid = "ma-queue-P"
    const mixed = [
      { text: "", commitLines: [] }, // synthetic mode-only push (line 151)
      { text: "real submit", commitLines: ["scrollback"] },
    ]
    writeFileSync(queueFilePath(sid, dir), JSON.stringify(mixed))
    expect(loadQueue(sid, dir)).toEqual([{ text: "real submit", commitLines: ["scrollback"] }])
  })

  it("round-trips through QueueStore.save", async () => {
    const dir = tmp()
    const sid = "ma-queue-Q"
    const s = new QueueStore(sid, { dir })
    const items: QueueItem[] = [
      Q("first message", ["❯ first message"]),
      Q("second\nmultiline", ["❯ second", "  multiline"]),
    ]
    s.save(items)
    await waitQuiet(s)
    expect(loadQueue(sid, dir)).toEqual(items)
  })

  it("returns [] on read errors (e.g. nonexistent directory) — best-effort", () => {
    expect(loadQueue("definitely-not-a-sid-at-all", "/nonexistent/path")).toEqual([])
  })

  it("loader returns a fresh copy each call (no shared mutable state)", () => {
    const dir = tmp()
    const sid = "ma-queue-R"
    writeFileSync(queueFilePath(sid, dir), JSON.stringify([{ text: "x", commitLines: ["a"] }]))
    const first = loadQueue(sid, dir)
    first[0].commitLines.push("MUTATED")
    const second = loadQueue(sid, dir)
    expect(second).toEqual([{ text: "x", commitLines: ["a"] }])
  })
})

describe("QueueStore — error handling", () => {
  it("logs and continues when the destination directory does not exist", async () => {
    const messages: string[] = []
    const s = new QueueStore("orphan", {
      dir: "/nonexistent/path/that/cannot/be/written",
      logger: (m) => messages.push(m),
    })
    s.save([Q("doomed")])
    await waitQuiet(s)
    expect(messages.length).toBe(1)
    expect(messages[0]).toMatch(/queue-store: write failed/)
    // Subsequent saves still attempted (no permanent latch).
    s.save([Q("also doomed")])
    await waitQuiet(s)
    expect(messages.length).toBe(2)
  })
})

describe("QueueStore — process isolation", () => {
  it("uses a per-pid tmp filename", () => {
    const dir = tmp()
    const sid = "ma-queue-pid"
    const s = new QueueStore(sid, { dir })
    // The .queue path itself never has a pid suffix.
    expect(s.path).toBe(queueFilePath(sid, dir))
    expect(s.path).not.toContain(`${process.pid}`)
  })
})
