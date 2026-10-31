import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { Facility, Severity } from "../bus/diagnostic-bus.ts"
import type { AgentEvent } from "../sdk/events.ts"
import { SINK_ERROR_CODE } from "../sdk/sink-guard.ts"

import {
  type DiagnosticEvent,
  diagnosticFromLogEvent,
  eventLogFilePath,
  PERSIST_ERROR_CODE,
  parseEntryLine,
  type ReplayGap,
  readEventLogFile,
  type SessionEntry,
  SessionEventLog,
  serializeEntry,
  serializeEntrySse,
} from "./event-log.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-event-log-"))
}

/**
 * A dir no one can create, root included: its parent is a regular file, so
 * mkdir and writes fail with ENOTDIR. (A missing absolute path is creatable by root.)
 */
function unwritableDir(): string {
  const file = join(tmp(), "not-a-dir")
  writeFileSync(file, "")
  return join(file, "sub")
}

function turn(n: number): AgentEvent {
  return { type: "turn_started", turn: n }
}

function warn(code: string): DiagnosticEvent {
  return { severity: Severity.Warning, facility: Facility.User, code, message: code }
}

/** A fake clock: 1000, 1001, 1002, ... */
function clock(): () => number {
  let t = 1000
  return () => t++
}

/** Subscribe and collect into an array. */
function collect(
  log: SessionEventLog,
  options?: Parameters<SessionEventLog["subscribe"]>[1],
): { entries: SessionEntry[]; off: () => void } {
  const entries: SessionEntry[] = []
  const off = log.subscribe((e) => entries.push(e), options)
  return { entries, off }
}

function seqs(entries: readonly SessionEntry[]): number[] {
  return entries.map((e) => e.seq)
}

function sinkErrorEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  return entries.filter((e) => e.ch === "diag" && e.data.code === SINK_ERROR_CODE)
}

describe("SessionEventLog entries", () => {
  it("stamps v, seq from 0, ts, sessionId, and the channel", () => {
    const log = new SessionEventLog({ sessionId: "s1", now: clock() })
    const a = log.appendEvent(turn(1))
    const b = log.appendDiag(warn("x.y"))
    expect(a).toEqual({ v: 1, seq: 0, ts: 1000, sessionId: "s1", ch: "event", data: turn(1) })
    expect(b).toEqual({ v: 1, seq: 1, ts: 1001, sessionId: "s1", ch: "diag", data: warn("x.y") })
    expect(log.stats()).toMatchObject({ firstSeq: 0, nextSeq: 2, size: 2 })
  })

  it("keeps each log separate: no shared state between instances", () => {
    const a = new SessionEventLog({ sessionId: "a" })
    const b = new SessionEventLog({ sessionId: "b" })
    a.appendEvent(turn(1))
    a.appendEvent(turn(2))
    const fromB = collect(b, { fromSeq: 0 })
    expect(b.appendEvent(turn(1)).seq).toBe(0)
    expect(fromB.entries.map((e) => e.sessionId)).toEqual(["b"])
    expect(a.stats().nextSeq).toBe(2)
  })

  it("bounds memory to the configured capacity, dropping the oldest", () => {
    const log = new SessionEventLog({ sessionId: "s", capacity: 3 })
    for (let i = 0; i < 5; i++) log.appendEvent(turn(i))
    expect(log.stats()).toMatchObject({ firstSeq: 2, nextSeq: 5, size: 3, capacity: 3 })
  })

  it("rejects a capacity that is not a positive integer", () => {
    expect(() => new SessionEventLog({ sessionId: "s", capacity: 0 })).toThrow(RangeError)
    expect(() => new SessionEventLog({ sessionId: "s", capacity: 1.5 })).toThrow(RangeError)
  })
})

describe("SessionEventLog.subscribe", () => {
  it("streams live entries only when fromSeq is absent", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    log.appendEvent(turn(1))
    const sub = collect(log)
    log.appendEvent(turn(2))
    expect(seqs(sub.entries)).toEqual([1])
  })

  it("replays from seq 0, then streams live", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    for (let i = 0; i < 3; i++) log.appendEvent(turn(i))
    const sub = collect(log, { fromSeq: 0 })
    expect(seqs(sub.entries)).toEqual([0, 1, 2])
    log.appendEvent(turn(3))
    expect(seqs(sub.entries)).toEqual([0, 1, 2, 3])
  })

  it("replays from a middle seq", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    for (let i = 0; i < 6; i++) log.appendEvent(turn(i))
    const sub = collect(log, { fromSeq: 4 })
    log.appendEvent(turn(6))
    expect(seqs(sub.entries)).toEqual([4, 5, 6])
  })

  it("fromSeq out of a memory-only buffer: reports the gap once, replays from the oldest", () => {
    const log = new SessionEventLog({ sessionId: "s", capacity: 3 })
    for (let i = 0; i < 10; i++) log.appendEvent(turn(i))
    const gaps: ReplayGap[] = []
    const order: string[] = []
    log.subscribe((e) => order.push(`entry:${e.seq}`), {
      fromSeq: 2,
      onGap: (gap) => {
        gaps.push(gap)
        order.push("gap")
      },
    })
    expect(gaps).toEqual([{ fromSeq: 2, firstSeq: 7 }])
    expect(order).toEqual(["gap", "entry:7", "entry:8", "entry:9"])
  })

  it("fromSeq out of the buffer without onGap still replays from the oldest", () => {
    const log = new SessionEventLog({ sessionId: "s", capacity: 2 })
    for (let i = 0; i < 5; i++) log.appendEvent(turn(i))
    expect(seqs(collect(log, { fromSeq: 0 }).entries)).toEqual([3, 4])
  })

  it("reports no gap when fromSeq is still in the buffer or is the next seq", () => {
    const log = new SessionEventLog({ sessionId: "s", capacity: 3 })
    for (let i = 0; i < 5; i++) log.appendEvent(turn(i))
    const gaps: ReplayGap[] = []
    collect(log, { fromSeq: 2, onGap: (g) => gaps.push(g) })
    collect(log, { fromSeq: 5, onGap: (g) => gaps.push(g) })
    expect(gaps).toEqual([])
  })

  it("treats fromSeq above the next seq as live only", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    log.appendEvent(turn(0))
    const gaps: ReplayGap[] = []
    const sub = collect(log, { fromSeq: 99, onGap: (g) => gaps.push(g) })
    log.appendEvent(turn(1))
    expect(seqs(sub.entries)).toEqual([1])
    expect(gaps).toEqual([])
  })

  it("rejects an invalid fromSeq, channel, or minSeverity", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const noop = (): void => {}
    expect(() => log.subscribe(noop, { fromSeq: -1 })).toThrow(RangeError)
    expect(() => log.subscribe(noop, { fromSeq: Number.NaN })).toThrow(RangeError)
    expect(() => log.subscribe(noop, { fromSeq: 1.5 })).toThrow(RangeError)
    // @ts-expect-error: an unknown channel name is the point of this check
    expect(() => log.subscribe(noop, { channels: ["events"] })).toThrow(RangeError)
    // @ts-expect-error: a number outside the Severity enum is the point of this check
    expect(() => log.subscribe(noop, { minSeverity: 9 })).toThrow(RangeError)
    expect(log.stats().listeners).toBe(0)
  })

  it("filters by channel", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const events = collect(log, { channels: ["event"] })
    const diags = collect(log, { channels: ["diag"] })
    log.appendEvent(turn(1))
    log.appendDiag(warn("a.b"))
    expect(events.entries.map((e) => e.ch)).toEqual(["event"])
    expect(diags.entries.map((e) => e.ch)).toEqual(["diag"])
  })

  it("filters diagnostics by minSeverity and never filters events by it", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const sub = collect(log, { minSeverity: Severity.Warning })
    log.appendDiag({ ...warn("debug"), severity: Severity.Debug })
    log.appendDiag({ ...warn("info"), severity: Severity.Info })
    log.appendDiag(warn("warn"))
    log.appendDiag({ ...warn("error"), severity: Severity.Error })
    log.appendEvent(turn(1))
    expect(sub.entries.map((e) => (e.ch === "diag" ? e.data.code : e.data.type))).toEqual([
      "warn",
      "error",
      "turn_started",
    ])
  })

  it("applies filters to the replay too", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    log.appendEvent(turn(0))
    log.appendDiag(warn("a"))
    log.appendEvent(turn(1))
    expect(seqs(collect(log, { fromSeq: 0, channels: ["event"] }).entries)).toEqual([0, 2])
  })

  it("stops delivery on unsubscribe, and unsubscribing twice is harmless", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const sub = collect(log)
    log.appendEvent(turn(0))
    sub.off()
    sub.off()
    log.appendEvent(turn(1))
    expect(seqs(sub.entries)).toEqual([0])
    expect(log.stats().listeners).toBe(0)
  })

  it("an unsubscribe during delivery skips the rest for that listener only", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    let offLater = (): void => {}
    log.subscribe(() => offLater())
    const later = collect(log)
    offLater = later.off
    const third = collect(log)
    log.appendEvent(turn(0))
    expect(later.entries).toEqual([])
    expect(seqs(third.entries)).toEqual([0])
  })
})

describe("SessionEventLog ordering", () => {
  it("delivers an entry appended from a listener after the current one, to everyone in order", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const a: number[] = []
    const b: number[] = []
    log.subscribe((e) => {
      a.push(e.seq)
      if (e.seq === 0) log.appendDiag(warn("from.listener"))
    })
    log.subscribe((e) => b.push(e.seq))
    log.appendEvent(turn(0))
    expect(a).toEqual([0, 1])
    expect(b).toEqual([0, 1])
  })

  it("a listener that subscribes another one inside delivery causes no duplicates", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const inner: number[] = []
    let added = false
    log.subscribe(() => {
      if (added) return
      added = true
      log.subscribe((e) => inner.push(e.seq), { fromSeq: 0 })
    })
    log.appendEvent(turn(0))
    log.appendEvent(turn(1))
    expect(inner).toEqual([0, 1])
  })

  it("an entry appended during a replay arrives after the replay, once", () => {
    const log = new SessionEventLog({ sessionId: "s", capacity: 3 })
    for (let i = 0; i < 3; i++) log.appendEvent(turn(i))
    const got: number[] = []
    log.subscribe(
      (e) => {
        got.push(e.seq)
        if (e.seq === 0) log.appendEvent(turn(3))
      },
      { fromSeq: 0 },
    )
    expect(got).toEqual([0, 1, 2, 3])
  })
})

describe("SessionEventLog listener isolation", () => {
  it("a throwing listener affects neither the producer nor other listeners", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    log.subscribe(
      () => {
        throw new Error("broken")
      },
      { name: "bad" },
    )
    const good = collect(log)
    for (let i = 0; i < 3; i++) expect(log.appendEvent(turn(i)).seq).toBeGreaterThanOrEqual(0)
    // The good listener got every event, plus the one sink-error diagnostic
    // right after the event that first failed.
    expect(good.entries.map((e) => (e.ch === "diag" ? e.data.code : e.data.type))).toEqual([
      "turn_started",
      SINK_ERROR_CODE,
      "turn_started",
      "turn_started",
    ])
    const report = sinkErrorEntries(good.entries)
    expect(report).toHaveLength(1)
    expect(report[0]?.data).toMatchObject({
      severity: Severity.Error,
      facility: Facility.User,
      data: { listener: "bad", error: "broken" },
    })
    // Three events plus the diagnostic itself, all thrown on, all counted.
    expect(log.stats().sinkErrors).toBe(4)
  })

  it("emits one sink-error per failing listener", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const fail = (): void => {
      throw new Error("x")
    }
    log.subscribe(fail, { name: "one" })
    log.subscribe(fail, { name: "two" })
    const all = collect(log, { channels: ["diag"] })
    log.appendEvent(turn(0))
    log.appendEvent(turn(1))
    const names = sinkErrorEntries(all.entries).map((e) =>
      e.ch === "diag" ? e.data.data?.listener : undefined,
    )
    expect(names).toEqual(["one", "two"])
  })

  it("names unnamed listeners listener-<n>", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    const all = collect(log, { channels: ["diag"] })
    log.subscribe(() => {
      throw new Error("x")
    })
    log.appendEvent(turn(0))
    expect(sinkErrorEntries(all.entries)[0]?.data).toMatchObject({
      data: { listener: "listener-2" },
    })
  })

  it("isolates a throw during the replay and finishes the replay in order", () => {
    const log = new SessionEventLog({ sessionId: "s" })
    for (let i = 0; i < 3; i++) log.appendEvent(turn(i))
    const got: number[] = []
    log.subscribe(
      (e) => {
        got.push(e.seq)
        if (e.seq === 1) throw new Error("mid-replay")
      },
      { fromSeq: 0 },
    )
    // 0..2 replayed, then the sink-error diagnostic (seq 3) arrives live.
    expect(got).toEqual([0, 1, 2, 3])
    expect(log.stats()).toMatchObject({ nextSeq: 4, sinkErrors: 1 })
  })

  it("isolates a throwing onGap like a throwing listener", () => {
    const log = new SessionEventLog({ sessionId: "s", capacity: 1 })
    log.appendEvent(turn(0))
    log.appendEvent(turn(1))
    const got: number[] = []
    log.subscribe((e) => got.push(e.seq), {
      fromSeq: 0,
      onGap: () => {
        throw new Error("gap handler broken")
      },
    })
    expect(got).toEqual([1, 2])
    expect(log.stats().sinkErrors).toBe(1)
  })
})

describe("SessionEventLog durable JSONL", () => {
  it("writes one entry per line and reads them back", () => {
    const path = eventLogFilePath("sid-1", tmp())
    const log = new SessionEventLog({ sessionId: "sid-1", path, now: clock() })
    const a = log.appendEvent(turn(1))
    const b = log.appendDiag(warn("a.b"))
    const lines = readFileSync(path, "utf-8").split("\n")
    expect(lines).toEqual([JSON.stringify(a), JSON.stringify(b), ""])
    expect(readEventLogFile(path)).toEqual({ entries: [a, b], dropped: 0 })
  })

  it("continues seq after a restart and replays the whole session from the file", () => {
    const path = eventLogFilePath("sid-2", tmp())
    const first = new SessionEventLog({ sessionId: "sid-2", path, capacity: 2 })
    for (let i = 0; i < 5; i++) first.appendEvent(turn(i))

    // A new process opens the same session.
    const second = new SessionEventLog({ sessionId: "sid-2", path, capacity: 2 })
    expect(second.stats()).toMatchObject({ firstSeq: 3, nextSeq: 5, size: 2 })
    const gaps: ReplayGap[] = []
    const all = collect(second, { fromSeq: 0, onGap: (g) => gaps.push(g) })
    second.appendEvent(turn(5))
    expect(seqs(all.entries)).toEqual([0, 1, 2, 3, 4, 5])
    expect(gaps).toEqual([])
    expect(seqs(readEventLogFile(path).entries)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("replays an evicted range from the file without a gap", () => {
    const path = eventLogFilePath("sid-3", tmp())
    const log = new SessionEventLog({ sessionId: "sid-3", path, capacity: 2 })
    for (let i = 0; i < 6; i++) log.appendEvent(turn(i))
    const gaps: ReplayGap[] = []
    const sub = collect(log, { fromSeq: 1, onGap: (g) => gaps.push(g) })
    expect(seqs(sub.entries)).toEqual([1, 2, 3, 4, 5])
    expect(gaps).toEqual([])
  })

  it("drops a torn last line, malformed lines, and other sessions on load", () => {
    const dir = tmp()
    const path = eventLogFilePath("sid-4", dir)
    const log = new SessionEventLog({ sessionId: "sid-4", path })
    log.appendEvent(turn(0))
    log.appendEvent(turn(1))
    appendFileSync(path, "not json\n")
    appendFileSync(path, `${JSON.stringify({ ...log.appendEvent(turn(2)), sessionId: "other" })}\n`)
    appendFileSync(path, '{"v":1,"seq":9,"ts":1,"sessionId":"sid-4","ch":"ev')
    const read = readEventLogFile(path, "sid-4")
    expect(seqs(read.entries)).toEqual([0, 1, 2])
    expect(read.dropped).toBe(3)
    const reopened = new SessionEventLog({ sessionId: "sid-4", path })
    expect(reopened.stats().nextSeq).toBe(3)
  })

  it("reads a missing file as empty", () => {
    expect(readEventLogFile(join(tmp(), "nope.events.jsonl"))).toEqual({ entries: [], dropped: 0 })
  })

  it("never throws on a write failure and reports exactly one events.persist-error", () => {
    const path = join(unwritableDir(), "s.events.jsonl")
    const log = new SessionEventLog({ sessionId: "s", path })
    const sub = collect(log)
    for (let i = 0; i < 3; i++) log.appendEvent(turn(i))
    const reports = sub.entries.filter((e) => e.ch === "diag" && e.data.code === PERSIST_ERROR_CODE)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.data).toMatchObject({ severity: Severity.Error, data: { path, seq: 0 } })
    // Memory still has everything; listeners still saw entries in order.
    expect(seqs(sub.entries)).toEqual([0, 1, 2, 3])
    // Three events plus the diagnostic itself failed to write.
    expect(log.stats()).toMatchObject({ nextSeq: 4, persistErrors: 4 })
  })
})

describe("wire format", () => {
  const entry: SessionEntry = {
    v: 1,
    seq: 7,
    ts: 1234,
    sessionId: "s",
    ch: "event",
    data: { type: "text_delta", id: "1:text", text: "line one\nline two" },
  }

  it("serializes one JSONL line that parses back to the same object", () => {
    const line = serializeEntry(entry)
    expect(line.endsWith("\n")).toBe(true)
    expect(line.slice(0, -1)).not.toContain("\n")
    expect(parseEntryLine(line)).toEqual(entry)
  })

  it("serializes one SSE event with id: seq and a single data line", () => {
    const sse = serializeEntrySse(entry)
    expect(sse).toBe(`id: 7\ndata: ${JSON.stringify(entry)}\n\n`)
    const dataLine = sse.split("\n")[1] ?? ""
    expect(parseEntryLine(dataLine.slice("data: ".length))).toEqual(entry)
  })

  it("rejects lines that are not entries", () => {
    const base = { v: 1, seq: 0, ts: 1, sessionId: "s" }
    const diag = { severity: 4, facility: 1, code: "a", message: "m" }
    expect(parseEntryLine("")).toBeNull()
    expect(parseEntryLine("[]")).toBeNull()
    expect(parseEntryLine(JSON.stringify({ ...base, v: 2, ch: "event", data: turn(0) }))).toBeNull()
    expect(
      parseEntryLine(JSON.stringify({ ...base, seq: -1, ch: "event", data: turn(0) })),
    ).toBeNull()
    expect(parseEntryLine(JSON.stringify({ ...base, ch: "other", data: turn(0) }))).toBeNull()
    expect(parseEntryLine(JSON.stringify({ ...base, ch: "event", data: {} }))).toBeNull()
    expect(
      parseEntryLine(JSON.stringify({ ...base, ch: "diag", data: { ...diag, severity: 8 } })),
    ).toBeNull()
    expect(
      parseEntryLine(JSON.stringify({ ...base, ch: "diag", data: { ...diag, data: { a: {} } } })),
    ).toBeNull()
    expect(parseEntryLine(JSON.stringify({ ...base, ch: "diag", data: diag }))).not.toBeNull()
  })

  it("keeps unknown event kinds, since kinds are additive", () => {
    const line = JSON.stringify({
      v: 1,
      seq: 0,
      ts: 1,
      sessionId: "s",
      ch: "event",
      data: { type: "future_kind" },
    })
    expect(JSON.stringify(parseEntryLine(line)?.data)).toBe('{"type":"future_kind"}')
  })
})

describe("helpers", () => {
  it("maps a diagnostic-bus LogEvent to a DiagnosticEvent", () => {
    expect(
      diagnosticFromLogEvent({
        ts: 1,
        severity: Severity.Notice,
        facility: Facility.Auth,
        source: "auth.refresh",
        message: "refreshed",
        structuredData: { provider: "x" },
      }),
    ).toEqual({
      severity: Severity.Notice,
      facility: Facility.Auth,
      code: "auth.refresh",
      message: "refreshed",
      data: { provider: "x" },
    })
  })

  it("puts the durable file next to the session transcript", () => {
    expect(eventLogFilePath("abc", "/sessions")).toBe("/sessions/abc.events.jsonl")
  })
})
