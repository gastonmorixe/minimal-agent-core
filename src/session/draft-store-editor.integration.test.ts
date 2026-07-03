/**
 * Integration test: EditorController + DraftStore.
 *
 * Drives a real EditorController against a real DraftStore (via a tmp
 * sessions dir) to verify the production wiring:
 *
 *   - Typing → editor "input" event → draft saved.
 *   - Submit → draft cleared.
 *   - Cancel (Ctrl+C on empty buffer) → draft cleared.
 *   - setBuffer (used by --resume to restore a saved draft) → draft re-saved.
 *
 * Mirrors the wiring done in `src/index.ts` after the EditorController is
 * constructed. Tests use `inputDebounceMs: 0` so the "input" event fires
 * synchronously from the keystroke handler — keeps assertions deterministic
 * without sleeping for the default 120ms debounce.
 */

import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { EditorController } from "../host/editor-controller.ts"

import { DraftStore, draftFilePath } from "./draft-store.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  resumed = false
  rawModes: boolean[] = []
  setEncoding(e: BufferEncoding): this {
    this.encoding = e
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.resumed = false
    return this
  }
  setRawMode(v: boolean): this {
    this.rawModes.push(v)
    return this
  }
  send(c: string): void {
    this.emit("data", c)
  }
}

class FakeOutput {
  chunks: string[] = []
  isTTY = true
  columns = 80
  rows = 24
  write(c: string | Uint8Array): boolean {
    this.chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c))
    return true
  }
}

class FakeCompositor {
  liveHeight = 1
  scrollback: string[] = []
  setLiveArea(_lines: string[], _cursor: { row: number; col: number } | null): void {}
  setLiveHeight(n: number): void {
    this.liveHeight = n
  }
  writeStream(s: string): void {
    this.scrollback.push(s)
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-draft-int-"))
}

interface InputEvent {
  text: string
  seq: number
}

function wireDraft(editor: EditorController, store: DraftStore): void {
  // Mirrors the wiring in src/index.ts.
  editor.on("input", (e: InputEvent) => store.save(e.text))
  editor.on("submit", () => store.clear())
  editor.on("cancel", () => store.clear())
}

async function waitQuiet(s: DraftStore, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now()
  while (s.isWriting() || s.pendingText() !== null) {
    if (Date.now() - t0 > timeoutMs) throw new Error("draft store never quiesced")
    await new Promise((r) => setTimeout(r, 5))
  }
}

function makeEditor(stdin: FakeTTYInput, output: FakeOutput, compositor: FakeCompositor) {
  return new EditorController({
    prompt: "> ",
    continuationPrompt: "  ",
    compositor: compositor as any,
    stdin: stdin as any,
    output: output as any,
    inputDebounceMs: 0, // synchronous — no real-time debounce in this test
  })
}

describe("integration: EditorController + DraftStore", () => {
  it("typing into the editor persists each keystroke batch to disk", async () => {
    const dir = tmp()
    const sid = "ma-draft-int-A"
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const editor = makeEditor(stdin, output, compositor)
    const store = new DraftStore(sid, { dir })
    wireDraft(editor, store)
    editor.start()

    // Type "hello"
    for (const ch of "hello") stdin.send(ch)
    await waitQuiet(store)

    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe("hello")
    editor.stop()
  })

  it("Enter (submit) clears the on-disk draft", async () => {
    const dir = tmp()
    const sid = "ma-draft-int-B"
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const editor = makeEditor(stdin, output, compositor)
    const store = new DraftStore(sid, { dir })
    wireDraft(editor, store)
    editor.start()

    for (const ch of "about to submit") stdin.send(ch)
    await waitQuiet(store)
    expect(existsSync(draftFilePath(sid, dir))).toBe(true)

    stdin.send("\r") // submit
    await waitQuiet(store)
    expect(existsSync(draftFilePath(sid, dir))).toBe(false)
    editor.stop()
  })

  it("Ctrl+C on empty buffer (cancel) clears the draft", async () => {
    const dir = tmp()
    const sid = "ma-draft-int-C"
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const editor = makeEditor(stdin, output, compositor)
    const store = new DraftStore(sid, { dir })
    wireDraft(editor, store)
    editor.start()

    // Type something, then erase it manually (Ctrl+U), then Ctrl+C → cancel.
    for (const ch of "doomed") stdin.send(ch)
    await waitQuiet(store)
    expect(existsSync(draftFilePath(sid, dir))).toBe(true)

    stdin.send("\x15") // Ctrl+U: kill to line start (clears the buffer)
    await waitQuiet(store)
    // Empty buffer → save("") → clear → file gone
    expect(existsSync(draftFilePath(sid, dir))).toBe(false)

    stdin.send("\x03") // Ctrl+C on empty buffer → cancel event
    await waitQuiet(store)
    expect(existsSync(draftFilePath(sid, dir))).toBe(false)
    editor.stop()
  })

  it("setBuffer (e.g. on --resume) restores draft text and re-saves it", async () => {
    const dir = tmp()
    const sid = "ma-draft-int-D"
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const editor = makeEditor(stdin, output, compositor)
    const store = new DraftStore(sid, { dir })
    wireDraft(editor, store)
    editor.start()

    // Simulate resume: editor.setBuffer is called by index.ts with the
    // draft loaded from disk.
    editor.setBuffer("restored draft from previous session")
    await waitQuiet(store)

    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe(
      "restored draft from previous session",
    )

    // Now the user continues typing — the draft should track the changes.
    stdin.send("!")
    await waitQuiet(store)
    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe(
      "restored draft from previous session!",
    )
    editor.stop()
  })

  it("multi-line drafts round-trip", async () => {
    const dir = tmp()
    const sid = "ma-draft-int-E"
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const editor = makeEditor(stdin, output, compositor)
    const store = new DraftStore(sid, { dir })
    wireDraft(editor, store)
    editor.start()

    // setBuffer handles \n as newlines.
    editor.setBuffer("line one\nline two\nline three")
    await waitQuiet(store)

    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe("line one\nline two\nline three")
    editor.stop()
  })

  it("rapid typing produces a stable final on-disk state (coalescing)", async () => {
    const dir = tmp()
    const sid = "ma-draft-int-F"
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const editor = makeEditor(stdin, output, compositor)
    const store = new DraftStore(sid, { dir })
    wireDraft(editor, store)
    editor.start()

    // Burst-type 100 chars synchronously (no awaits between sends).
    const text = "the quick brown fox jumps over the lazy dog. ".repeat(3)
    for (const ch of text) stdin.send(ch)
    await waitQuiet(store)

    expect(readFileSync(draftFilePath(sid, dir), "utf-8")).toBe(text)
    editor.stop()
  })
})
