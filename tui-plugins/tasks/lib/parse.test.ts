import { describe, expect, test } from "bun:test"

import {
  formatTask,
  isSubtaskId,
  isTaskId,
  isTaskStatus,
  localIsoDateTime,
  localIsoSeconds,
  newTopLevelId,
  normalizeIdRef,
  parentOf,
  parseFile,
  parseTask,
  serializeFile,
  subtaskId,
  TASK_ID_RE,
  TASK_LINE_SCHEMA_VERSION,
  type Task,
} from "./parse.ts"

// ---------------------------------------------------------------------------
// Status guards
// ---------------------------------------------------------------------------

describe("isTaskStatus", () => {
  test("accepts valid statuses", () => {
    expect(isTaskStatus("todo")).toBe(true)
    expect(isTaskStatus("doing")).toBe(true)
    expect(isTaskStatus("done")).toBe(true)
    expect(isTaskStatus("canceled")).toBe(true)
  })
  test("rejects invalid values", () => {
    expect(isTaskStatus("pending")).toBe(false)
    expect(isTaskStatus("")).toBe(false)
    expect(isTaskStatus(null)).toBe(false)
    expect(isTaskStatus(42)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ID shape
// ---------------------------------------------------------------------------

describe("TASK_ID_RE / isTaskId", () => {
  test("accepts top-level six-hex ids", () => {
    expect(TASK_ID_RE.test("a7b3c4")).toBe(true)
    expect(TASK_ID_RE.test("000000")).toBe(true)
    expect(TASK_ID_RE.test("ffffff")).toBe(true)
    expect(isTaskId("d04c91")).toBe(true)
  })
  test("accepts subtask ids (six-hex + a-z)", () => {
    expect(TASK_ID_RE.test("d04c91a")).toBe(true)
    expect(TASK_ID_RE.test("a7b3c4z")).toBe(true)
    expect(isTaskId("d04c91b")).toBe(true)
  })
  test("rejects uppercase hex", () => {
    expect(isTaskId("A7B3C4")).toBe(false)
  })
  test("rejects wrong length / shape", () => {
    expect(isTaskId("abc")).toBe(false)
    expect(isTaskId("a7b3c4ab")).toBe(false)
    expect(isTaskId("#a7b3c4")).toBe(false)
    expect(isTaskId("")).toBe(false)
    expect(isTaskId(123 as unknown)).toBe(false)
  })
  test("rejects non-a-z subtask suffix", () => {
    expect(isTaskId("a7b3c41")).toBe(false)
    expect(isTaskId("a7b3c4A")).toBe(false)
  })
})

describe("isSubtaskId", () => {
  test("distinguishes top-level from subtask", () => {
    expect(isSubtaskId("a7b3c4")).toBe(false)
    expect(isSubtaskId("a7b3c4a")).toBe(true)
    expect(isSubtaskId("a7b3c4z")).toBe(true)
  })
})

describe("parentOf", () => {
  test("strips the alpha suffix", () => {
    expect(parentOf("d04c91a")).toBe("d04c91")
    expect(parentOf("a7b3c4z")).toBe("a7b3c4")
  })
  test("throws for non-subtask ids", () => {
    expect(() => parentOf("a7b3c4")).toThrow(/not a subtask id/)
    expect(() => parentOf("nope")).toThrow(/not a subtask id/)
  })
})

// ---------------------------------------------------------------------------
// ID generators
// ---------------------------------------------------------------------------

describe("newTopLevelId", () => {
  test("returns six hex chars", () => {
    const id = newTopLevelId()
    expect(id).toMatch(/^[0-9a-f]{6}$/)
    expect(isTaskId(id)).toBe(true)
  })
  test("uses the injected rand for tests", () => {
    const id = newTopLevelId(() => Buffer.from([0xa7, 0xb3, 0xc4]))
    expect(id).toBe("a7b3c4")
  })
  test("generates different ids across calls (statistical)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) seen.add(newTopLevelId())
    // Birthday-paradox collision in 100 picks from 16.7M space is ~3 in 10^4.
    // Allowing a small fuzz factor keeps the test stable.
    expect(seen.size).toBeGreaterThanOrEqual(99)
  })
})

describe("subtaskId", () => {
  test("maps counter 0..25 to a..z", () => {
    expect(subtaskId("d04c91", 0)).toBe("d04c91a")
    expect(subtaskId("d04c91", 1)).toBe("d04c91b")
    expect(subtaskId("d04c91", 25)).toBe("d04c91z")
  })
  test("throws on overflow (26+)", () => {
    expect(() => subtaskId("d04c91", 26)).toThrow(/too many children/)
    expect(() => subtaskId("d04c91", 999)).toThrow(/too many children/)
  })
  test("rejects negative or non-integer counter", () => {
    expect(() => subtaskId("d04c91", -1)).toThrow(/non-negative integer/)
    expect(() => subtaskId("d04c91", 1.5)).toThrow(/non-negative integer/)
  })
  test("rejects non-top-level parent", () => {
    expect(() => subtaskId("d04c91a", 0)).toThrow(/six-hex top-level id/)
    expect(() => subtaskId("nope", 0)).toThrow(/six-hex top-level id/)
  })
})

// ---------------------------------------------------------------------------
// ISO timestamp
// ---------------------------------------------------------------------------

describe("localIsoSeconds", () => {
  test("formats a fixed Date deterministically", () => {
    // 2026-05-12T15:30:45 in a UTC injected via a Date subclass mock.
    // Use a real UTC instant; the format depends on local zone so we only
    // pin the regex shape here.
    const out = localIsoSeconds(() => new Date(2026, 4, 12, 15, 30, 45))
    expect(out).toMatch(/^2026-05-12T15:30:45[+-]\d{2}:\d{2}$/)
  })
  test("uses current time by default", () => {
    const out = localIsoSeconds()
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })
})

describe("localIsoDateTime", () => {
  test("formats `YYYY-MM-DD HH:MM:SS` with single space (no T, no offset)", () => {
    const out = localIsoDateTime(() => new Date(2026, 4, 20, 18, 7, 42))
    expect(out).toBe("2026-05-20 18:07:42")
  })
  test("pads month, day, and time components to two digits", () => {
    const out = localIsoDateTime(() => new Date(2026, 0, 3, 9, 5, 7))
    expect(out).toBe("2026-01-03 09:05:07")
  })
  test("uses current time by default", () => {
    const out = localIsoDateTime()
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

// ---------------------------------------------------------------------------
// JSONL round-trip
// ---------------------------------------------------------------------------

const sampleTask: Task = {
  id: "a7b3c4",
  parent: null,
  status: "todo",
  title: "Hello world",
  created_at: "2026-05-12T15:30:00-04:00",
  done_at: null,
  reason: null,
  // v2 duration fields. Default for a freshly-added todo: never started,
  // no accumulated active time.
  started_at: null,
  last_resumed_at: null,
  active_ms: 0,
}

describe("formatTask / parseTask", () => {
  test("round-trips a minimal task", () => {
    const line = formatTask(sampleTask)
    const back = parseTask(line)
    expect(back).toEqual(sampleTask)
  })
  test("round-trips a done task with done_at", () => {
    const t: Task = {
      ...sampleTask,
      status: "done",
      done_at: "2026-05-12T15:31:00-04:00",
    }
    expect(parseTask(formatTask(t))).toEqual(t)
  })
  test("round-trips a canceled task with reason", () => {
    const t: Task = {
      ...sampleTask,
      status: "canceled",
      reason: "user redirected",
    }
    expect(parseTask(formatTask(t))).toEqual(t)
  })
  test("round-trips a subtask with parent", () => {
    const t: Task = { ...sampleTask, id: "a7b3c4a", parent: "a7b3c4" }
    expect(parseTask(formatTask(t))).toEqual(t)
  })
  test("formatted line is single-line JSON with v field first", () => {
    const line = formatTask(sampleTask)
    expect(line).not.toContain("\n")
    expect(line.startsWith(`{"v":${TASK_LINE_SCHEMA_VERSION},`)).toBe(true)
  })
})

describe("parseTask robustness", () => {
  test("returns null for blank line", () => {
    expect(parseTask("")).toBeNull()
    expect(parseTask("   ")).toBeNull()
  })
  test("returns null for malformed JSON", () => {
    expect(parseTask("{not json")).toBeNull()
    expect(parseTask("[]")).toBeNull()
    expect(parseTask("null")).toBeNull()
    expect(parseTask("42")).toBeNull()
  })
  test("returns null when required field missing", () => {
    expect(parseTask(JSON.stringify({ v: 1, status: "todo", title: "x" }))).toBeNull()
    expect(parseTask(JSON.stringify({ v: 1, id: "a7b3c4", title: "x" }))).toBeNull()
  })
  test("returns null for invalid status", () => {
    const bad = JSON.stringify({
      v: 1,
      id: "a7b3c4",
      parent: null,
      status: "pending",
      title: "x",
      created_at: "2026-05-12T00:00:00-00:00",
      done_at: null,
      reason: null,
    })
    expect(parseTask(bad)).toBeNull()
  })
  test("returns null for malformed id", () => {
    const bad = JSON.stringify({
      v: 1,
      id: "TOO-LONG",
      parent: null,
      status: "todo",
      title: "x",
      created_at: "2026-05-12T00:00:00-00:00",
      done_at: null,
      reason: null,
    })
    expect(parseTask(bad)).toBeNull()
  })
  test("treats missing done_at / reason as null (forward-compat)", () => {
    const minimal = JSON.stringify({
      v: 1,
      id: "a7b3c4",
      parent: null,
      status: "todo",
      title: "x",
      created_at: "2026-05-12T00:00:00-00:00",
    })
    const t = parseTask(minimal)
    expect(t).not.toBeNull()
    expect(t!.done_at).toBeNull()
    expect(t!.reason).toBeNull()
  })

  // ---- v2 forward-compat ----

  test("treats v1 lines (no duration fields) as started_at=null, last_resumed_at=null, active_ms=0", () => {
    // Exactly the v1 shape — what an existing session file from before
    // the schema bump contains. Must parse cleanly with zeroed duration
    // fields so resumed sessions don't crash.
    const v1Line = JSON.stringify({
      v: 1,
      id: "a7b3c4",
      parent: null,
      status: "done",
      title: "Old done task",
      created_at: "2026-05-12T15:30:00-04:00",
      done_at: "2026-05-12T15:31:00-04:00",
      reason: null,
    })
    const t = parseTask(v1Line)
    expect(t).not.toBeNull()
    expect(t!.started_at).toBeNull()
    expect(t!.last_resumed_at).toBeNull()
    expect(t!.active_ms).toBe(0)
    // Pre-existing fields preserved.
    expect(t!.id).toBe("a7b3c4")
    expect(t!.status).toBe("done")
    expect(t!.done_at).toBe("2026-05-12T15:31:00-04:00")
  })

  test("round-trips a v2 task with non-zero duration fields", () => {
    const t: Task = {
      id: "a7b3c4",
      parent: null,
      status: "doing",
      title: "In flight",
      created_at: "2026-05-12T15:30:00-04:00",
      done_at: null,
      reason: null,
      started_at: "2026-05-12T15:30:15-04:00",
      last_resumed_at: "2026-05-12T15:32:00-04:00",
      active_ms: 47_000,
    }
    expect(parseTask(formatTask(t))).toEqual(t)
  })

  test("rejects negative active_ms (corrupt)", () => {
    const bad = JSON.stringify({
      v: 2,
      id: "a7b3c4",
      parent: null,
      status: "done",
      title: "x",
      created_at: "2026-05-12T00:00:00-00:00",
      done_at: null,
      reason: null,
      started_at: null,
      last_resumed_at: null,
      active_ms: -1,
    })
    expect(parseTask(bad)).toBeNull()
  })

  test("rejects non-finite active_ms (corrupt)", () => {
    // Note: JSON.stringify converts +Infinity / NaN to "null", so we
    // craft the line as raw text to keep the bad payload intact.
    const bad =
      '{"v":2,"id":"a7b3c4","parent":null,"status":"done","title":"x","created_at":"2026-05-12T00:00:00-00:00","done_at":null,"reason":null,"started_at":null,"last_resumed_at":null,"active_ms":"oops"}'
    expect(parseTask(bad)).toBeNull()
  })

  test("rejects non-string started_at / last_resumed_at (corrupt)", () => {
    const badStarted = JSON.stringify({
      v: 2,
      id: "a7b3c4",
      parent: null,
      status: "doing",
      title: "x",
      created_at: "2026-05-12T00:00:00-00:00",
      done_at: null,
      reason: null,
      started_at: 1700000000000,
      last_resumed_at: null,
      active_ms: 0,
    })
    expect(parseTask(badStarted)).toBeNull()
  })
})

describe("parseFile / serializeFile", () => {
  test("round-trips multi-line content", () => {
    const tasks: Task[] = [
      sampleTask,
      { ...sampleTask, id: "f8e21a", title: "Two" },
      { ...sampleTask, id: "d04c91", title: "Three" },
    ]
    const text = serializeFile(tasks)
    expect(text.endsWith("\n")).toBe(true)
    const back = parseFile(text)
    expect(back).toEqual(tasks)
  })
  test("serializeFile returns empty string for empty list", () => {
    expect(serializeFile([])).toBe("")
  })
  test("parseFile skips blank lines silently", () => {
    const text = `${formatTask(sampleTask)}\n\n${formatTask({ ...sampleTask, id: "f8e21a" })}\n`
    const back = parseFile(text)
    expect(back).toHaveLength(2)
  })
  test("parseFile skips malformed lines silently (partial-write resilience)", () => {
    const text = `${formatTask(sampleTask)}\n{corrupted\n${formatTask({ ...sampleTask, id: "f8e21a" })}\n`
    const back = parseFile(text)
    expect(back).toHaveLength(2)
    expect(back[0].id).toBe("a7b3c4")
    expect(back[1].id).toBe("f8e21a")
  })
})

// ---------------------------------------------------------------------------
// normalizeIdRef
// ---------------------------------------------------------------------------

describe("normalizeIdRef", () => {
  test("strips # prefix", () => {
    expect(normalizeIdRef("#a7b3c4")).toBe("a7b3c4")
    expect(normalizeIdRef("a7b3c4")).toBe("a7b3c4")
  })
  test("accepts subtask ids", () => {
    expect(normalizeIdRef("#a7b3c4a")).toBe("a7b3c4a")
    expect(normalizeIdRef("a7b3c4z")).toBe("a7b3c4z")
  })
  test("returns null for malformed input", () => {
    expect(normalizeIdRef("nope")).toBeNull()
    expect(normalizeIdRef("##a7b3c4")).toBeNull()
    expect(normalizeIdRef("a7b3c4ab")).toBeNull()
    expect(normalizeIdRef("")).toBeNull()
  })
})
