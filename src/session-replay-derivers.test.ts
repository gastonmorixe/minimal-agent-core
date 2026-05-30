import { describe, expect, it } from "bun:test"

import type { Task } from "../plugins/tasks/lib/parse.ts"

import {
  deriveDisplayFallback,
  deriveEditDisplay,
  deriveTaskDisplay,
  deriveWriteDisplay,
  snapshotTasksAt,
} from "./session-replay-derivers.ts"

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

/** Build a Task fixture; defaults match the live store's v2 shape. */
function task(overrides: Partial<Task> & Pick<Task, "id" | "title">): Task {
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
  // Structural fallback (no sidecar) : the deriver splits the
  // model-facing content text into header / body / footer. This is the
  // path used when no per-session `<sid>.tasks.jsonl` sidecar is
  // available (tests, pre-v2 sessions, plugin disabled).
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

describe("deriveTaskDisplay — sidecar-driven re-render (colorized path)", () => {
  // When the per-session `.tasks.jsonl` sidecar is supplied, the
  // deriver feeds a SNAPSHOT of the task tree (at the call's wall-clock
  // cutoff) into the plugin's `renderToolDisplay({ansi: true})` so the
  // body lands in scrollback with the same hot-pink / lime / sky-blue
  // styling the live agent drew. This is what the user asked for in
  // "restored tasks are missing the beautiful styling and colors".
  const t0 = "2026-05-28T08:00:00-04:00"
  const t1 = "2026-05-28T08:05:00-04:00"
  const t2 = "2026-05-28T08:10:00-04:00"
  const callTs = new Date("2026-05-28T08:15:00-04:00")

  function threeDoneTasks(): Task[] {
    return [
      task({
        id: "aaa",
        title: "first",
        status: "done",
        created_at: t0,
        started_at: t0,
        done_at: t1,
        active_ms: 300000,
      }),
      task({
        id: "bbb",
        title: "second",
        status: "done",
        created_at: t0,
        started_at: t1,
        done_at: t2,
        active_ms: 300000,
      }),
      task({
        id: "ccc",
        title: "third",
        status: "done",
        created_at: t0,
        started_at: t2,
        done_at: callTs.toISOString(),
        active_ms: 300000,
      }),
    ]
  }

  it("emits an ANSI-colored body when sidecar + input are supplied", () => {
    const d = deriveTaskDisplay({
      content: "(model-facing content goes here)",
      input: { action: "done", id: "#ccc" },
      callTs,
      sidecarTasks: threeDoneTasks(),
    })
    expect(d?.display).toBeDefined()
    // ANSI escapes present in the body. The plain content-split path
    // would produce 0 escapes for a body of model-facing text.
    expect(d!.display!).toMatch(/\x1b\[/)
    // Status icons + ids both render after the gutter.
    expect(stripAnsi(d!.display!)).toContain("✔")
    expect(stripAnsi(d!.display!)).toContain("#aaa")
    expect(stripAnsi(d!.display!)).toContain("#bbb")
    expect(stripAnsi(d!.display!)).toContain("#ccc")
  })

  it("`action=done` with all tasks done upgrades to ALL DONE header", () => {
    const d = deriveTaskDisplay({
      content: "(noise)",
      input: { action: "done", id: "#ccc" },
      callTs,
      sidecarTasks: threeDoneTasks(),
    })
    // The header carries the celebratory ALL DONE row, matching the
    // live plugin's `marked_done → all_done` upgrade when the post-
    // mutation snapshot has every top-level task done.
    expect(stripAnsi(d!.displayHeader!)).toMatch(/ALL DONE · 3\/3/)
  })

  it("per-call cutoff reconstructs status (aaa doing, bbb/ccc todo at +1m)", () => {
    // Cutoff at t0+1min:
    //   aaa: started_at=t0 (≤ cutoff), done_at=t1 (> cutoff) → doing
    //   bbb: started_at=t1 (> cutoff) → todo
    //   ccc: started_at=t2 (> cutoff) → todo
    // Before this fix, all three would render in their `done` final
    // status because the sidecar's mutated-in-place state has them
    // done. With the per-call cutoff, history is faithful.
    const earlyCutoff = new Date("2026-05-28T08:01:00-04:00")
    const d = deriveTaskDisplay({
      content: "(noise)",
      input: { action: "start", id: "#aaa" },
      callTs: earlyCutoff,
      sidecarTasks: threeDoneTasks(),
    })
    const plain = stripAnsi(d!.display!)
    // All three are visible (created at t0 = before cutoff).
    expect(plain).toContain("#aaa")
    expect(plain).toContain("#bbb")
    expect(plain).toContain("#ccc")
    // Per-call status reconstruction.
    const snap = snapshotTasksAt(threeDoneTasks(), earlyCutoff)
    expect(snap.find((t) => t.id === "aaa")?.status).toBe("doing")
    expect(snap.find((t) => t.id === "bbb")?.status).toBe("todo")
    expect(snap.find((t) => t.id === "ccc")?.status).toBe("todo")
  })

  it("falls back to content-split when sidecar is empty (no usable snapshot)", () => {
    const d = deriveTaskDisplay({
      content: "HDR LINE\n  body\nFTR LINE",
      input: { action: "list" },
      sidecarTasks: [],
    })
    // Content-split path active : header/body/footer match the
    // structural split.
    expect(d?.displayHeader).toBe("HDR LINE")
    expect(d?.display).toBe("  body")
    expect(d?.displayFooter).toBe("FTR LINE")
  })

  it("falls back to content-split when no input is provided (paranoia)", () => {
    const d = deriveTaskDisplay({
      content: "HDR\nBODY\nFTR",
      sidecarTasks: threeDoneTasks(),
      // no `input`, so the plugin renderer can't pick an action verb
    })
    // Content-split path active.
    expect(d?.displayHeader).toBe("HDR")
    expect(d?.displayFooter).toBe("FTR")
  })

  it("add_many with empty sidecar still renders (special-case so initial calls work)", () => {
    // The sidecar is empty BEFORE any task gets added, but an
    // add_many call's render is meaningful (the count header).
    const d = deriveTaskDisplay({
      content: "(noise)",
      input: { action: "add_many", titles: ["a", "b"] },
      sidecarTasks: [],
    })
    // Sidecar-driven path took over (header is from the plugin renderer,
    // not the content-split fallback).
    expect(d?.displayHeader).toBeDefined()
    expect(stripAnsi(d!.displayHeader!)).toMatch(/added 2 tasks/)
  })
})

describe("snapshotTasksAt", () => {
  // The per-call cutoff machine: time-travel the task list to a
  // historical wall-clock so the plugin renderer sees the state as it
  // existed at THAT moment, not the sidecar's current state.
  it("returns a copy when cutoff is null (current state)", () => {
    const tasks: Task[] = [task({ id: "a", title: "x", status: "done" })]
    const snap = snapshotTasksAt(tasks, null)
    expect(snap.length).toBe(1)
    expect(snap[0].status).toBe("done")
    expect(snap).not.toBe(tasks) // a copy, not the same reference
  })

  it("drops tasks whose created_at is after the cutoff", () => {
    const tasks: Task[] = [
      task({ id: "a", title: "early", created_at: "2026-05-28T08:00:00-04:00" }),
      task({ id: "b", title: "late", created_at: "2026-05-28T09:00:00-04:00" }),
    ]
    const snap = snapshotTasksAt(tasks, new Date("2026-05-28T08:30:00-04:00"))
    expect(snap.length).toBe(1)
    expect(snap[0].id).toBe("a")
  })

  it("reconstructs status: done if done_at <= cutoff, doing if started_at <= cutoff, else todo", () => {
    const t1 = "2026-05-28T08:00:00-04:00"
    const t2 = "2026-05-28T08:10:00-04:00"
    const t3 = "2026-05-28T08:20:00-04:00"
    const tasks: Task[] = [
      task({
        id: "a",
        title: "finished early",
        status: "done",
        created_at: t1,
        started_at: t1,
        done_at: t2,
      }),
      task({
        id: "b",
        title: "in progress at cutoff",
        status: "done",
        created_at: t1,
        started_at: t1,
        done_at: t3,
      }),
      task({
        id: "c",
        title: "not started at cutoff",
        status: "done",
        created_at: t1,
        started_at: t3,
        done_at: t3,
      }),
    ]
    const cutoff = new Date("2026-05-28T08:15:00-04:00")
    const snap = snapshotTasksAt(tasks, cutoff)
    expect(snap.find((t) => t.id === "a")?.status).toBe("done")
    expect(snap.find((t) => t.id === "b")?.status).toBe("doing")
    expect(snap.find((t) => t.id === "c")?.status).toBe("todo")
  })

  it("clears done_at / started_at on reconstructed doing / todo rows", () => {
    const tasks: Task[] = [
      task({
        id: "a",
        title: "in flight at cutoff",
        status: "done",
        created_at: "2026-05-28T08:00:00-04:00",
        started_at: "2026-05-28T08:00:00-04:00",
        done_at: "2026-05-28T08:30:00-04:00",
      }),
    ]
    const snap = snapshotTasksAt(tasks, new Date("2026-05-28T08:15:00-04:00"))
    expect(snap[0].status).toBe("doing")
    // done_at must be null since the task isn't done yet at cutoff.
    expect(snap[0].done_at).toBeNull()
    // started_at is preserved (the task DID start at this point).
    expect(snap[0].started_at).toBe("2026-05-28T08:00:00-04:00")
  })

  it("preserves canceled status as-is (no explicit cancel timestamp to reason from)", () => {
    const tasks: Task[] = [
      task({
        id: "a",
        title: "abandoned",
        status: "canceled",
        created_at: "2026-05-28T08:00:00-04:00",
      }),
    ]
    const snap = snapshotTasksAt(tasks, new Date("2026-05-28T08:30:00-04:00"))
    expect(snap[0].status).toBe("canceled")
  })

  it("handles unparseable timestamps gracefully (treats as null)", () => {
    const tasks: Task[] = [
      task({
        id: "a",
        title: "broken ts",
        status: "done",
        created_at: "not-a-date",
        done_at: "also-not-a-date",
      }),
    ]
    // Should not throw. created_at unparseable → not dropped. done_at
    // unparseable → status defaults to todo.
    const snap = snapshotTasksAt(tasks, new Date("2026-05-28T08:30:00-04:00"))
    expect(snap.length).toBe(1)
    expect(snap[0].status).toBe("todo")
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
