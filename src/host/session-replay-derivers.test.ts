import { afterEach, describe, expect, it } from "bun:test"

import {
  clearReplayRenderers,
  deriveDisplayFallback,
  deriveEditDisplay,
  deriveTaskDisplay,
  deriveWriteDisplay,
  type ReplaySidecarTask,
  type ReplayToolRenderInput,
  registerReplayRenderer,
} from "./session-replay-derivers.ts"

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Build a sidecar-task fixture using the CORE-LOCAL structural type. */
function sidecarTask(
  overrides: Partial<ReplaySidecarTask> & Pick<ReplaySidecarTask, "id" | "title">,
): ReplaySidecarTask {
  return {
    parent: null,
    status: "todo",
    created_at: "2026-05-28T08:00:00-04:00",
    done_at: null,
    reason: null,
    started_at: null,
    last_resumed_at: null,
    active_ms: 0,
    ...overrides,
  }
}

describe("deriveTaskDisplay", () => {
  // Structural fallback: the deriver splits the model-facing content
  // text into header / body / footer. This is the CORE-LOCAL plain-text
  // path used when no plugin replay renderer is registered (tests,
  // plugin disabled, non-resume runs).
  it("splits a 3+ line content into header / body / footer", () => {
    const content = [
      "+ added 3 tasks · 0/3 · 2026-05-28 13:50:22",
      "   1  ○  #aaa  First step",
      "   2  ○  #bbb  Second step",
      "   3  ○  #ccc  Third step",
      " 0 done · 0 doing · 3 todo",
    ].join("\n")
    const d = deriveTaskDisplay({ content })
    expect(d?.displayHeader).toBe("+ added 3 tasks · 0/3 · 2026-05-28 13:50:22")
    expect(d?.displayFooter).toBe(" 0 done · 0 doing · 3 todo")
    expect(d?.display).toBe(
      ["   1  ○  #aaa  First step", "   2  ○  #bbb  Second step", "   3  ○  #ccc  Third step"].join(
        "\n",
      ),
    )
  })

  it("handles the ALL DONE shape (the user's 41200730 repro)", () => {
    const content = [
      "✔ ALL DONE · 39/39 · 2026-05-28 08:29:05",
      "   1  ✔  #3dc7fa  one task",
      "   2  ✔  #d2abe0  another task",
      " ✦ ALL DONE · 39 done · 47m 59s",
    ].join("\n")
    const d = deriveTaskDisplay({ content })
    expect(d?.displayHeader).toBe("✔ ALL DONE · 39/39 · 2026-05-28 08:29:05")
    expect(d?.displayFooter).toBe(" ✦ ALL DONE · 39 done · 47m 59s")
    expect(d?.display).toBe("   1  ✔  #3dc7fa  one task\n   2  ✔  #d2abe0  another task")
  })

  it("two-line content: first = header, second = body, no footer", () => {
    const d = deriveTaskDisplay({
      content: "◐ started #abc · 0/1 · ts\n  1  ◐  #abc  doing",
    })
    expect(d?.displayHeader).toBe("◐ started #abc · 0/1 · ts")
    expect(d?.display).toBe("  1  ◐  #abc  doing")
    expect(d?.displayFooter).toBeUndefined()
  })

  it("single-line content: header only", () => {
    const d = deriveTaskDisplay({ content: "only line" })
    expect(d?.displayHeader).toBe("only line")
    expect(d?.display).toBeUndefined()
    expect(d?.displayFooter).toBeUndefined()
  })

  it("returns undefined for empty / whitespace-only content", () => {
    expect(deriveTaskDisplay({ content: "" })).toBeUndefined()
    expect(deriveTaskDisplay({ content: "\n\n\n" })).toBeUndefined()
  })

  it("strips trailing <ma::agent::output-preview> annotation before splitting", () => {
    // The agent appends this when a TUI preview was clamped : we don't
    // want it bleeding into the derived footer.
    const content = [
      "header",
      "  body 1",
      "  body 2",
      "footer line",
      "",
      '<ma::agent::output-preview shown="3" total="5" tool="Task">noise</ma::agent::output-preview>',
    ].join("\n")
    const d = deriveTaskDisplay({ content })
    expect(d?.displayHeader).toBe("header")
    expect(d?.displayFooter).toBe("footer line")
    expect(d?.display).toBe("  body 1\n  body 2")
  })

  it("strips trailing [truncated:] annotation before splitting", () => {
    const content = ["header", "body", "footer", "", "[truncated: at 64 KB...]"].join("\n")
    const d = deriveTaskDisplay({ content })
    expect(d?.displayHeader).toBe("header")
    expect(d?.displayFooter).toBe("footer")
    expect(d?.display).toBe("body")
  })

  it("strips trailing newlines before evaluating line count", () => {
    // A content of "header\nbody\nfooter\n\n\n" should still split into 3 parts.
    const d = deriveTaskDisplay({ content: "header\nbody\nfooter\n\n\n" })
    expect(d?.displayHeader).toBe("header")
    expect(d?.display).toBe("body")
    expect(d?.displayFooter).toBe("footer")
  })
})

describe("replay renderer seam (loader-registered plugin renderers)", () => {
  // The seam: a plugin may register a per-tool replay renderer (the
  // loader resolves it from the plugin manifest's `replayRenderers`
  // declaration). `deriveDisplayFallback` gives the registered renderer
  // first crack at a row; `undefined` / a throw falls back to the
  // core-local built-ins (content-split for Task, synthesized diffs for
  // Edit / Write, nothing for unknown tools).
  afterEach(() => {
    clearReplayRenderers()
  })

  it("routes a row through a registered renderer (round-trip with a fake plugin handler)", () => {
    const seen: ReplayToolRenderInput[] = []
    registerReplayRenderer("FakeTool", (ctx) => {
      seen.push(ctx)
      return { displayHeader: "fake hdr", display: `FAKE:${ctx.content}`, displayFooter: "ftr" }
    })
    const callTs = new Date("2026-05-28T08:15:00-04:00")
    const sidecar = [sidecarTask({ id: "aaa", title: "first", status: "done" })]
    const d = deriveDisplayFallback({
      toolName: "FakeTool",
      input: { action: "x" },
      content: "model-facing content",
      isError: false,
      callTs,
      sidecarTasks: sidecar,
    })
    expect(d).toEqual({
      displayHeader: "fake hdr",
      display: "FAKE:model-facing content",
      displayFooter: "ftr",
    })
    // The renderer received exactly the row's data.
    expect(seen).toHaveLength(1)
    expect(seen[0].input).toEqual({ action: "x" })
    expect(seen[0].content).toBe("model-facing content")
    expect(seen[0].callTs).toBe(callTs)
    expect(seen[0].sidecarTasks).toBe(sidecar)
  })

  it("a registered renderer overrides the built-in Task content-split", () => {
    registerReplayRenderer("Task", () => ({ display: "PLUGIN BODY" }))
    const d = deriveDisplayFallback({
      toolName: "Task",
      input: { action: "list" },
      content: "hdr\nbody\nftr",
      isError: false,
    })
    expect(d).toEqual({ display: "PLUGIN BODY" })
  })

  it("renderer returning undefined falls back to the core content-split", () => {
    registerReplayRenderer("Task", () => undefined)
    const d = deriveDisplayFallback({
      toolName: "Task",
      input: { action: "list" },
      content: "hdr\nbody\nftr",
      isError: false,
    })
    expect(d?.displayHeader).toBe("hdr")
    expect(d?.display).toBe("body")
    expect(d?.displayFooter).toBe("ftr")
  })

  it("renderer throwing falls back to the core content-split (a buggy plugin never breaks resume)", () => {
    registerReplayRenderer("Task", () => {
      throw new Error("boom")
    })
    const d = deriveDisplayFallback({
      toolName: "Task",
      input: { action: "list" },
      content: "hdr\nbody\nftr",
      isError: false,
    })
    expect(d?.displayHeader).toBe("hdr")
    expect(d?.display).toBe("body")
    expect(d?.displayFooter).toBe("ftr")
  })

  it("no renderer registered (plugin absent) → core fallback path", () => {
    const d = deriveDisplayFallback({
      toolName: "Task",
      input: { action: "list" },
      content: "hdr\nbody\nftr",
      isError: false,
    })
    expect(d?.displayHeader).toBe("hdr")
    expect(d?.display).toBe("body")
    expect(d?.displayFooter).toBe("ftr")
  })

  it("error rows never reach the renderer", () => {
    let called = 0
    registerReplayRenderer("Task", () => {
      called += 1
      return { display: "nope" }
    })
    const d = deriveDisplayFallback({
      toolName: "Task",
      input: {},
      content: "Task error: whatever",
      isError: true,
    })
    expect(d).toBeUndefined()
    expect(called).toBe(0)
  })

  it("register returns an unregister handle; first registration wins until removed", () => {
    const un = registerReplayRenderer("FakeTool", () => ({ display: "one" }))
    const d1 = deriveDisplayFallback({
      toolName: "FakeTool",
      input: {},
      content: "c",
      isError: false,
    })
    expect(d1).toEqual({ display: "one" })
    un()
    const d2 = deriveDisplayFallback({
      toolName: "FakeTool",
      input: {},
      content: "c",
      isError: false,
    })
    expect(d2).toBeUndefined()
  })
})

describe("deriveEditDisplay", () => {
  it("synthesizes a unified diff from old_string / new_string", () => {
    const d = deriveEditDisplay({
      file_path: "/abs/x.json",
      old_string: 'old\nline\n"foo": 1',
      new_string: 'old\nline\n"foo": 2',
    })
    expect(d?.display).toBeDefined()
    const plain = stripAnsi(d!.display!)
    expect(plain).toContain("--- a//abs/x.json")
    expect(plain).toContain("+++ b//abs/x.json")
    // The exact whole-line replacement: both lines surface as -/+.
    expect(plain).toContain('-"foo": 1')
    expect(plain).toContain('+"foo": 2')
  })

  it("returns undefined when old_string is empty (no diff to compute)", () => {
    const d = deriveEditDisplay({
      file_path: "/abs/x.json",
      old_string: "",
      new_string: "new",
    })
    expect(d).toBeUndefined()
  })

  it("returns undefined when any required field is missing", () => {
    expect(deriveEditDisplay({ old_string: "a", new_string: "b" })).toBeUndefined()
    expect(deriveEditDisplay({ file_path: "/x", new_string: "b" })).toBeUndefined()
    expect(deriveEditDisplay({ file_path: "/x", old_string: "a" })).toBeUndefined()
  })

  it("returns undefined when fields are wrong types (defensive)", () => {
    // `Record<string, unknown>` accepts anything at the type level, so
    // these calls don't need a `@ts-expect-error` : we're testing the
    // runtime `typeof` guard the deriver uses, not the TS types.
    expect(deriveEditDisplay({ file_path: 42, old_string: "a", new_string: "b" })).toBeUndefined()
    expect(deriveEditDisplay({ file_path: "/x", old_string: 42, new_string: "b" })).toBeUndefined()
    expect(deriveEditDisplay({ file_path: "/x", old_string: "a", new_string: 42 })).toBeUndefined()
  })

  it("the synthesized display has hot-pink/lime ANSI from renderUnifiedDiff", () => {
    const d = deriveEditDisplay({
      file_path: "/abs/x.json",
      old_string: "old",
      new_string: "new",
    })
    expect(d?.display).toMatch(/\x1b\[/)
  })
})

describe("deriveWriteDisplay", () => {
  it("synthesizes a new-file diff from content arg", () => {
    const d = deriveWriteDisplay({
      file_path: "/abs/new.txt",
      content: "line a\nline b\nline c",
    })
    expect(d?.display).toBeDefined()
    const plain = stripAnsi(d!.display!)
    expect(plain).toContain("New file: /abs/new.txt")
    expect(plain).toContain("+line a")
    expect(plain).toContain("+line b")
    expect(plain).toContain("+line c")
  })

  it("returns undefined for empty content (nothing useful to render)", () => {
    expect(deriveWriteDisplay({ file_path: "/x", content: "" })).toBeUndefined()
  })

  it("returns undefined when required fields are missing", () => {
    expect(deriveWriteDisplay({ content: "x" })).toBeUndefined()
    expect(deriveWriteDisplay({ file_path: "/x" })).toBeUndefined()
  })
})

describe("deriveDisplayFallback (dispatch)", () => {
  it("routes Task name to the task deriver", () => {
    const d = deriveDisplayFallback({
      toolName: "Task",
      input: { action: "done", id: "#abc" },
      content: "✔ done\n  1  ✔  #abc  thing\n 1 done",
      isError: false,
    })
    expect(d?.displayHeader).toBe("✔ done")
    expect(d?.displayFooter).toBe(" 1 done")
  })

  it("routes Edit name to the edit deriver", () => {
    const d = deriveDisplayFallback({
      toolName: "Edit",
      input: { file_path: "/x", old_string: "a", new_string: "b" },
      content: "File edited: /x (1 replacement(s))",
      isError: false,
    })
    expect(d?.display).toBeDefined()
    expect(stripAnsi(d!.display!)).toContain("-a")
    expect(stripAnsi(d!.display!)).toContain("+b")
  })

  it("routes Write name to the write deriver", () => {
    const d = deriveDisplayFallback({
      toolName: "Write",
      input: { file_path: "/new", content: "hello" },
      content: "File written: /new",
      isError: false,
    })
    expect(d?.display).toBeDefined()
    expect(stripAnsi(d!.display!)).toContain("+hello")
  })

  it("returns undefined for unknown tool names (no derivation, falls back to content)", () => {
    expect(
      deriveDisplayFallback({
        toolName: "RandomTool",
        input: {},
        content: "stuff",
        isError: false,
      }),
    ).toBeUndefined()
  })

  it("returns undefined for is_error=true rows (errors render the model-facing content)", () => {
    // We don't want to synthesize a pretty diff over a failed Edit; the
    // error text is what the user needs to see.
    expect(
      deriveDisplayFallback({
        toolName: "Edit",
        input: { file_path: "/x", old_string: "a", new_string: "b" },
        content: "Edit error: old_string not found in /x",
        isError: true,
      }),
    ).toBeUndefined()
  })

  it("swallows derive errors (returns undefined instead of throwing)", () => {
    // Pass garbage that would normally explode somewhere. The wrapper
    // must catch.
    const d = deriveDisplayFallback({
      toolName: "Task",
      input: undefined,
      // biome-ignore lint/suspicious/noExplicitAny: deliberate garbage
      content: { not: "a string" } as any,
      isError: false,
    })
    expect(d).toBeUndefined()
  })
})
