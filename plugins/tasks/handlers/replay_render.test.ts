import { describe, expect, it } from "bun:test"

import type { Task } from "../lib/parse.ts"

import renderTaskReplay, { snapshotTasksAt } from "./replay_render.ts"

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

// These tests carry over the sidecar-driven re-render contract that
// lived in src/session-replay-derivers.test.ts before the replay seam
// (Wave A unit A-2) moved the colorized path into this plugin handler.
// The behavior is pinned unchanged: same snapshot semantics, same
// action mapping, same renderToolDisplay({ansi: true}) output path.
describe("renderTaskReplay — sidecar-driven re-render (colorized path)", () => {
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
    const d = renderTaskReplay({
      content: "(model-facing content goes here)",
      input: { action: "done", id: "#ccc" },
      callTs,
      sidecarTasks: threeDoneTasks(),
    })
    expect(d?.display).toBeDefined()
    // ANSI escapes present in the body.
    expect(d!.display!).toMatch(/\x1b\[/)
    // Status icons + ids both render after the gutter.
    expect(stripAnsi(d!.display!)).toContain("✔")
    expect(stripAnsi(d!.display!)).toContain("#aaa")
    expect(stripAnsi(d!.display!)).toContain("#bbb")
    expect(stripAnsi(d!.display!)).toContain("#ccc")
  })

  it("`action=done` with all tasks done upgrades to ALL DONE header", () => {
    const d = renderTaskReplay({
      content: "(noise)",
      input: { action: "done", id: "#ccc" },
      callTs,
      sidecarTasks: threeDoneTasks(),
    })
    // The header carries the celebratory ALL DONE row, matching the
    // live tool's `marked_done → all_done` upgrade when the post-
    // mutation snapshot has every top-level task done.
    expect(stripAnsi(d!.displayHeader!)).toMatch(/ALL DONE · 3\/3/)
  })

  it("per-call cutoff reconstructs status (aaa doing, bbb/ccc todo at +1m)", () => {
    // Cutoff at t0+1min:
    //   aaa: started_at=t0 (≤ cutoff), done_at=t1 (> cutoff) → doing
    //   bbb: started_at=t1 (> cutoff) → todo
    //   ccc: started_at=t2 (> cutoff) → todo
    const earlyCutoff = new Date("2026-05-28T08:01:00-04:00")
    const d = renderTaskReplay({
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

  it("declines (undefined) when sidecar is empty and the action is not add-like", () => {
    const d = renderTaskReplay({
      content: "HDR LINE\n  body\nFTR LINE",
      input: { action: "list" },
      callTs: null,
      sidecarTasks: [],
    })
    // The host's content-split fallback should run instead.
    expect(d).toBeUndefined()
  })

  it("declines (undefined) when no sidecar was loaded", () => {
    const d = renderTaskReplay({
      content: "HDR\nBODY\nFTR",
      input: { action: "list" },
      callTs: null,
      sidecarTasks: null,
    })
    expect(d).toBeUndefined()
  })

  it("add_many with empty sidecar still renders (initial calls precede any persisted task)", () => {
    const d = renderTaskReplay({
      content: "(noise)",
      input: { action: "add_many", titles: ["a", "b"] },
      callTs: null,
      sidecarTasks: [],
    })
    // The renderer took the row (header from renderToolDisplay, not a
    // decline).
    expect(d?.displayHeader).toBeDefined()
    expect(stripAnsi(d!.displayHeader!)).toMatch(/added 2 tasks/)
  })

  it("swallows malformed-sidecar errors and declines instead of throwing", () => {
    const d = renderTaskReplay({
      content: "(noise)",
      input: { action: "done", id: "#x" },
      callTs,
      // biome-ignore lint/suspicious/noExplicitAny: deliberate garbage
      sidecarTasks: [{ broken: true } as any],
    })
    expect(d).toBeUndefined()
  })
})

describe("snapshotTasksAt", () => {
  // The per-call cutoff machine: time-travel the task list to a
  // historical wall-clock so the renderer sees the state as it existed
  // at THAT moment, not the sidecar's current state.
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
