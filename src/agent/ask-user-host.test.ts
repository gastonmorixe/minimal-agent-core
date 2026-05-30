/**
 * Tests for `ask-user-host.ts` — the live-area implementation of
 * {@link AskUserFn}.
 *
 * Uses a fake editor (records setFooterLayer / clearFooterLayer calls)
 * and the real `Hooks` bus so we can drive `editor.key` events and
 * assert the modal reacts correctly.
 *
 * @module agent/ask-user-host.test
 */

import { describe, expect, test } from "bun:test"

import { FOOTER_LAYER_OVERLAY } from "../editor/types.ts"
import type { EditorKeyPayload } from "../editor-controller.ts"
import type { PreflightIssue } from "../llm/provider.ts"
import { Hooks } from "../plugins/hooks/hooks.ts"
import { displayWidth, stripAnsi } from "../term-width.ts"

import { type AskUserHostEditor, createAskUserHost, translateEditorKey } from "./ask-user-host.ts"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeEditor implements AskUserHostEditor {
  // The modal paints into the above-prompt decoration band. A non-empty call
  // is a "paint"; an empty array is a "clear".
  calls: Array<{ kind: "paint" | "clear"; lines: string[] }> = []

  setDecorationLines(lines: string[]): void {
    this.calls.push(
      lines.length === 0 ? { kind: "clear", lines: [] } : { kind: "paint", lines: [...lines] },
    )
  }
  /** The latest painted decoration lines, or null if the last call cleared. */
  lastPainted(): string[] | null {
    const last = this.calls.at(-1)
    if (!last) return null
    return last.kind === "clear" ? null : last.lines
  }
  /** Clear count. `_id` is accepted+ignored for back-compat with old call sites. */
  clearedAt(_id?: string): number {
    return this.calls.filter((c) => c.kind === "clear").length
  }
  /** Paint count. `_id` is accepted+ignored for back-compat with old call sites. */
  paintCount(_id?: string): number {
    return this.calls.filter((c) => c.kind === "paint").length
  }
}

function makeIssue(): PreflightIssue {
  return {
    code: "test.issue",
    title: "Pick one",
    detail: "Detail body",
    options: [
      { id: "first", label: "First", isDefault: true },
      { id: "second", label: "Second" },
      { id: "third", label: "Third" },
    ],
  }
}

function fireKey(hooks: Hooks, key: string): EditorKeyPayload {
  const payload: EditorKeyPayload = {
    key,
    buffer: "",
    cursor: { row: 0, col: 0, visualRow: 0, rowsInLogicalLine: 1, totalLines: 1 },
    result: {},
  }
  hooks.emitSync("editor.key", payload)
  return payload
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("translateEditorKey", () => {
  test("maps Escape, Enter, Tab, arrows", () => {
    expect(translateEditorKey("Escape")).toEqual({ name: "escape" })
    expect(translateEditorKey("Enter")).toEqual({ name: "enter" })
    expect(translateEditorKey("Tab")).toEqual({ name: "tab" })
    expect(translateEditorKey("ArrowLeft")).toEqual({ name: "left" })
    expect(translateEditorKey("ArrowRight")).toEqual({ name: "right" })
    expect(translateEditorKey("ArrowUp")).toEqual({ name: "up" })
    expect(translateEditorKey("ArrowDown")).toEqual({ name: "down" })
  })
  test("maps single-char keys", () => {
    expect(translateEditorKey("a")).toEqual({ name: "char", ch: "a" })
    expect(translateEditorKey("Z")).toEqual({ name: "char", ch: "Z" })
  })
  test("maps Ctrl+X", () => {
    expect(translateEditorKey("Ctrl+R")).toEqual({ name: "ctrl", ch: "R" })
  })
  test("returns null for unknown multi-char keys", () => {
    expect(translateEditorKey("WeirdKey")).toBeNull()
    expect(translateEditorKey("F1")).toBeNull()
  })
})

describe("createAskUserHost", () => {
  test("paints the modal into the overlay layer on open", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks, output: { columns: 60 } })
    const promise = askUser(makeIssue())
    // Initial paint happened.
    expect(editor.paintCount(FOOTER_LAYER_OVERLAY)).toBe(1)
    const lines = editor.lastPainted()
    expect(lines?.join("\n")).toContain("Pick one")
    expect(lines?.join("\n")).toContain("Detail body")
    expect(lines?.join("\n")).toContain("First")
    // Cleanup
    fireKey(hooks, "Escape")
    await promise
  })

  test("Enter on default option resolves with first id", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    fireKey(hooks, "Enter")
    expect(await promise).toBe("first")
    // Decoration band cleared on close.
    expect(editor.clearedAt(FOOTER_LAYER_OVERLAY)).toBe(1)
  })

  test("renders at full terminal width by default (no maxWidth cap)", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks, output: { columns: 120 } })
    const promise = askUser(makeIssue())
    const painted = editor.lastPainted()
    expect(painted).not.toBeNull()
    expect(painted!.length).toBeGreaterThan(0)
    for (const line of painted!) expect(displayWidth(stripAnsi(line))).toBe(120)
    fireKey(hooks, "Escape")
    await promise
  })

  test("respects an explicit maxWidth cap when given", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks, output: { columns: 200 }, maxWidth: 60 })
    const promise = askUser(makeIssue())
    for (const line of editor.lastPainted()!) expect(displayWidth(stripAnsi(line))).toBe(60)
    fireKey(hooks, "Escape")
    await promise
  })

  test("pauses the activity row on open and resumes on close", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const events: string[] = []
    const askUser = createAskUserHost({
      editor,
      hooks,
      pauseActivity: () => events.push("pause"),
      resumeActivity: () => events.push("resume"),
    })
    const promise = askUser(makeIssue())
    expect(events).toEqual(["pause"]) // paused while the modal is up
    fireKey(hooks, "Enter")
    await promise
    expect(events).toEqual(["pause", "resume"]) // resumed once it closes
  })

  test("Right + Enter resolves with second id", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    fireKey(hooks, "ArrowRight")
    fireKey(hooks, "Enter")
    expect(await promise).toBe("second")
  })

  test("Tab + Tab + Enter resolves with third id", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    fireKey(hooks, "Tab")
    fireKey(hooks, "Tab")
    fireKey(hooks, "Enter")
    expect(await promise).toBe("third")
  })

  test("Escape resolves with null (cancel)", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    fireKey(hooks, "Escape")
    expect(await promise).toBeNull()
  })

  test("char shortcut resolves with matching option", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    // 's' uniquely matches "Second"
    fireKey(hooks, "s")
    expect(await promise).toBe("second")
  })

  test("ambiguous shortcut does not resolve", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const issue: PreflightIssue = {
      code: "x",
      title: "T",
      detail: "B",
      options: [
        { id: "save", label: "Save" },
        { id: "skip", label: "Skip" },
      ],
    }
    const promise = askUser(issue)
    fireKey(hooks, "s")
    // Not resolved yet — fire Enter to force resolution.
    fireKey(hooks, "Enter")
    expect(await promise).toBe("save")
  })

  test("every key fired during modal is halted (default-protect editor buffer)", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    const p1 = fireKey(hooks, "ArrowLeft")
    const p2 = fireKey(hooks, "x")
    expect(p1.result.halt).toBe(true)
    expect(p2.result.halt).toBe(true)
    fireKey(hooks, "Escape")
    await promise
  })

  test("repaints on every navigation key", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    const before = editor.paintCount(FOOTER_LAYER_OVERLAY)
    fireKey(hooks, "ArrowRight")
    fireKey(hooks, "ArrowRight")
    fireKey(hooks, "ArrowLeft")
    const after = editor.paintCount(FOOTER_LAYER_OVERLAY)
    expect(after - before).toBe(3)
    fireKey(hooks, "Escape")
    await promise
  })

  test("after resolution, further keys do NOT trigger more paints (listener removed)", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const promise = askUser(makeIssue())
    fireKey(hooks, "Enter")
    await promise
    const before = editor.calls.length
    const p = fireKey(hooks, "ArrowRight")
    // No listener should be subscribed any more.
    expect(p.result.halt).toBeUndefined()
    expect(editor.calls.length).toBe(before)
  })

  test("supports two sequential askUser calls (separate modals)", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })

    const p1 = askUser(makeIssue())
    fireKey(hooks, "Enter")
    expect(await p1).toBe("first")

    const p2 = askUser(makeIssue())
    fireKey(hooks, "ArrowRight")
    fireKey(hooks, "Enter")
    expect(await p2).toBe("second")
  })

  test("issue with no isDefault → first option is initial selection", async () => {
    const editor = new FakeEditor()
    const hooks = new Hooks()
    const askUser = createAskUserHost({ editor, hooks })
    const issue: PreflightIssue = {
      code: "x",
      title: "T",
      detail: "B",
      options: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Bravo" },
      ],
    }
    const promise = askUser(issue)
    fireKey(hooks, "Enter")
    expect(await promise).toBe("a")
  })
})
