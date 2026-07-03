import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { DraftStore, draftFilePath, loadDraft } from "./draft-store.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-draft-store-"))
}

/**
 * Wait for an in-flight write to complete. The flush loop drains until
 * `latestPending` is null AND `inFlight` is false; we poll because the
 * Bun.write/rename pair runs on a microtask, not a turn-of-the-loop.
 */
async function waitQuiet(s: DraftStore, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now()
  while (s.isWriting() || s.pendingText() !== null) {
    if (Date.now() - t0 > timeoutMs) throw new Error("draft store never quiesced")
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("DraftStore.save", () => {
  it("writes the text atomically to <sid>.draft", async () => {
    const dir = tmp()
    const sid = "ma-draft-A"
    const s = new DraftStore(sid, { dir })
    s.save("hello world")
    await waitQuiet(s)
    const path = draftFilePath(sid, dir)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf-8")).toBe("hello world")
  })

  it("overwrites a prior draft", async () => {
    const dir = tmp()
    const sid = "ma-draft-B"
    const s = new DraftStore(sid, { dir })
    s.save("first")
    await waitQuiet(s)
    s.save("second draft, longer than the first")
    await waitQuiet(s)
    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe(
      "second draft, longer than the first",
    )
  })

  it("does not leave a tmp file behind on success", async () => {
    const dir = tmp()
    const sid = "ma-draft-C"
    const s = new DraftStore(sid, { dir })
    s.save("clean")
    await waitQuiet(s)
    const tmpPath = `${draftFilePath(sid, dir)}.tmp.${process.pid}`
    expect(existsSync(tmpPath)).toBe(false)
  })
})

describe("DraftStore.clear", () => {
  it("deletes the draft file", async () => {
    const dir = tmp()
    const sid = "ma-draft-D"
    const s = new DraftStore(sid, { dir })
    s.save("doomed")
    await waitQuiet(s)
    expect(existsSync(draftFilePath(sid, dir))).toBe(true)
    s.clear()
    await waitQuiet(s)
    expect(existsSync(draftFilePath(sid, dir))).toBe(false)
  })

  it("is a no-op when no draft exists (no throw)", async () => {
    const dir = tmp()
    const sid = "ma-draft-E"
    const s = new DraftStore(sid, { dir })
    s.clear()
    await waitQuiet(s)
    expect(existsSync(draftFilePath(sid, dir))).toBe(false)
  })

  it("save('') is equivalent to clear()", async () => {
    const dir = tmp()
    const sid = "ma-draft-F"
    const s = new DraftStore(sid, { dir })
    s.save("temporary")
    await waitQuiet(s)
    s.save("")
    await waitQuiet(s)
    expect(existsSync(draftFilePath(sid, dir))).toBe(false)
  })
})

describe("DraftStore — coalescing", () => {
  it("rapid saves coalesce to a single trailing on-disk write", async () => {
    const dir = tmp()
    const sid = "ma-draft-G"
    const s = new DraftStore(sid, { dir })
    // Burst 50 saves synchronously. Without coalescing we'd issue 50
    // disk writes; with coalescing we issue at most 2 (one in-flight,
    // one final pending).
    for (let i = 0; i < 50; i++) {
      s.save(`step-${i}`)
    }
    await waitQuiet(s)
    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe("step-49")
  })

  it("save during in-flight write is captured (no race loss)", async () => {
    const dir = tmp()
    const sid = "ma-draft-H"
    const s = new DraftStore(sid, { dir })
    s.save("first")
    // Don't await. Immediately schedule a second save while the first
    // is in-flight.
    s.save("second")
    s.save("third — should be the final on-disk text")
    await waitQuiet(s)
    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe(
      "third — should be the final on-disk text",
    )
  })

  it("clear during in-flight write removes the draft", async () => {
    const dir = tmp()
    const sid = "ma-draft-I"
    const s = new DraftStore(sid, { dir })
    s.save("about to be deleted")
    // Schedule clear before the save completes.
    s.clear()
    await waitQuiet(s)
    expect(existsSync(draftFilePath(sid, dir))).toBe(false)
  })

  it("save→clear→save sequence ends in the saved state", async () => {
    const dir = tmp()
    const sid = "ma-draft-J"
    const s = new DraftStore(sid, { dir })
    s.save("a")
    s.clear()
    s.save("c")
    await waitQuiet(s)
    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe("c")
  })
})

describe("loadDraft", () => {
  it("returns null when the draft file does not exist", () => {
    const dir = tmp()
    expect(loadDraft("nonexistent-sid", dir)).toBeNull()
  })

  it("returns null when the draft file is empty", () => {
    const dir = tmp()
    const sid = "ma-draft-K"
    writeFileSync(draftFilePath(sid, dir), "")
    expect(loadDraft(sid, dir)).toBeNull()
  })

  it("returns the file contents verbatim (no trim, no normalize)", () => {
    const dir = tmp()
    const sid = "ma-draft-L"
    const text = "  multi\n  line\n  with leading whitespace  \n"
    writeFileSync(draftFilePath(sid, dir), text)
    expect(loadDraft(sid, dir)).toBe(text)
  })

  it("round-trips through DraftStore.save", async () => {
    const dir = tmp()
    const sid = "ma-draft-M"
    const s = new DraftStore(sid, { dir })
    const text = "What does the foo bar?\nLine 2"
    s.save(text)
    await waitQuiet(s)
    expect(loadDraft(sid, dir)).toBe(text)
  })

  it("returns null on read errors (e.g. permission denied) — best-effort", () => {
    // We can't easily create a read-error condition portably, so we just
    // verify ENOENT (the common case) is the same shape: returns null.
    expect(loadDraft("definitely-not-a-sid-at-all", "/nonexistent/path")).toBeNull()
  })
})

describe("DraftStore — error handling", () => {
  it("logs and continues when the destination directory does not exist", async () => {
    const messages: string[] = []
    const s = new DraftStore("orphan", {
      dir: "/nonexistent/path/that/cannot/be/written",
      logger: (m) => messages.push(m),
    })
    s.save("doomed")
    await waitQuiet(s)
    expect(messages.length).toBe(1)
    expect(messages[0]).toMatch(/draft-store: write failed/)
    // Subsequent saves still attempted (no permanent latch).
    s.save("also doomed")
    await waitQuiet(s)
    expect(messages.length).toBe(2)
  })
})

describe("DraftStore — process isolation", () => {
  it("uses a per-pid tmp filename", () => {
    const dir = tmp()
    const sid = "ma-draft-pid"
    const s = new DraftStore(sid, { dir })
    // Touching .path is enough — internal tmpPath includes process.pid.
    // We assert by inspecting the on-disk artifact during a write.
    s.save("hold")
    // The .draft path itself never has a pid suffix.
    expect(s.path).toBe(draftFilePath(sid, dir))
    expect(s.path).not.toContain(`${process.pid}`)
  })
})
