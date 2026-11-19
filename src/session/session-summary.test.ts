import { describe, expect, test } from "bun:test"

import type { SessionRecord } from "./session-store.ts"
import {
  computeSessionSummary,
  detachStatus,
  firstRealUserText,
  hasOpenAttach,
  lastRecordTime,
  stripInjectedContext,
} from "./session-summary.ts"

const TS = "2026-11-19T10:00:00.000Z"

function user(content: string | unknown[]): SessionRecord {
  return { kind: "user", ts: TS, content } as SessionRecord
}

describe("firstRealUserText", () => {
  test("skips a policy block and a self-closing mode-change tag", () => {
    const recs = [
      user(
        '<ma::agent::mode-change from="default" to="ask" at="x" /> fix the parser <ma::agent::policy>Current local time: 2026</ma::agent::policy>',
      ),
    ]
    expect(firstRealUserText(recs)).toBe("fix the parser")
  })

  test("joins text blocks and skips the injected ones", () => {
    const recs = [
      user([
        { type: "text", text: '<ma::agent::mode-change from="a" to="b" />' },
        { type: "text", text: "  go\n now  " },
        { type: "image", source: {} },
        { type: "text", text: "<ma::agent::policy>x</ma::agent::policy>" },
      ]),
    ]
    expect(firstRealUserText(recs)).toBe("go now")
  })

  test("a user record with only injected text is skipped for the next one", () => {
    const recs = [
      { kind: "meta", formatVersion: 1, sid: "s", createdAt: TS } as unknown as SessionRecord,
      user("<ma::agent::session-resumed>resumed</ma::agent::session-resumed>"),
      user("<system-reminder>be nice</system-reminder> real prompt"),
    ]
    expect(firstRealUserText(recs)).toBe("real prompt")
  })

  test("takes the task after a sub-agent role preamble", () => {
    const recs = [
      user(
        "You are Explorer: a scout.\n\n---\n\nYour task:\n\nFind the bug in X.\n\n---\n\n## How to finish",
      ),
    ]
    expect(firstRealUserText(recs)).toBe("Find the bug in X.")
  })

  test("cuts to maxLen with an ellipsis", () => {
    const out = firstRealUserText([user("a".repeat(50))], 10)
    expect(out).toBe(`${"a".repeat(9)}…`)
    expect(out.length).toBe(10)
  })

  test("returns empty text when no user record has real text", () => {
    expect(firstRealUserText([])).toBe("")
    expect(firstRealUserText([user("<ma::agent::policy>x</ma::agent::policy>")])).toBe("")
  })

  test("stripInjectedContext removes a lone tag", () => {
    expect(stripInjectedContext("<ma::agent::tasks>a").trim()).toBe("a")
  })

  test("m1: a self-closing tag, then a block of the same name, keeps the text between", () => {
    const t =
      '<ma::agent::mode-change from="a" />REAL<ma::agent::mode-change>x</ma::agent::mode-change>'
    expect(firstRealUserText([user(t)])).toBe("REAL")
  })

  test("m1: nested blocks of the same name leak nothing", () => {
    const t = "<ma::a::b>LEAK<ma::a::b>in</ma::a::b> LEAK</ma::a::b> REAL"
    expect(firstRealUserText([user(t)])).toBe("REAL")
  })

  test("m1: an unclosed block line is removed", () => {
    const t = "<ma::agent::policy>Current local time: 2026\nfix the bug"
    expect(firstRealUserText([user(t)])).toBe("fix the bug")
  })

  test("m1: a task marker split across text blocks is found", () => {
    const recs = [
      user([
        { type: "text", text: "You are Reviewer: check." },
        { type: "text", text: "---\n\nYour task:\n\nDo X" },
      ]),
    ]
    expect(firstRealUserText(recs)).toBe("Do X")
  })
})

describe("computeSessionSummary", () => {
  const meta = {
    kind: "meta",
    formatVersion: 1,
    sid: "s1",
    createdAt: TS,
    model: "no-such-model",
    cwd: "/tmp",
    systemHash: "",
    toolsHash: "",
    agentVersion: "t",
  } as SessionRecord

  test("counts user turns, takes the last time, and the detach status", () => {
    const recs: SessionRecord[] = [
      meta,
      user("<ma::agent::policy>p</ma::agent::policy>hello"),
      {
        kind: "assistant",
        ts: "2026-11-19T10:01:00.000Z",
        content: [{ type: "text", text: "hi" }],
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      } as SessionRecord,
      user("again"),
      { kind: "detach", ts: "2026-11-19T10:05:00.000Z", pid: 1, reason: "exit", exitCode: 0 },
    ]
    const s = computeSessionSummary(recs)
    expect(s.title).toBe("hello")
    expect(s.turns).toBe(2)
    expect(s.tokens).toBe(15)
    expect(s.estimated).toBe(false)
    expect(s.endedAt).toBe("2026-11-19T10:05:00.000Z")
    expect(s.status).toBe("done")
    // No registered price for the model: no cost field.
    expect("costUsd" in s).toBe(false)
  })

  test("0 turns for a session with only meta", () => {
    const s = computeSessionSummary([meta])
    expect(s.turns).toBe(0)
    expect(s.title).toBe("")
    expect(s.endedAt).toBe(TS)
  })

  test("detachStatus and lastRecordTime", () => {
    expect(detachStatus(undefined)).toBe("done")
    expect(detachStatus("exit", 0)).toBe("done")
    expect(detachStatus("exit", 2)).toBe("failed")
    expect(detachStatus("exit", 1)).toBe("failed")
    // N1: SIGHUP (closed terminal), SIGINT, SIGTERM exits are a stop, not a failure.
    expect(detachStatus("exit", 129)).toBe("done")
    expect(detachStatus("exit", 130)).toBe("done")
    expect(detachStatus("exit", 143)).toBe("done")
    expect(detachStatus("exit", 137)).toBe("failed")
    expect(detachStatus("signal")).toBe("done")
    expect(detachStatus("signal", 143)).toBe("done")
    expect(detachStatus("signal", 139)).toBe("failed")
    expect(detachStatus("error")).toBe("failed")
    expect(detachStatus("error", 0)).toBe("failed")
    expect(lastRecordTime([])).toBe("")
  })

  test("hasOpenAttach pairs attach and detach by pid", () => {
    const attach = {
      kind: "attach",
      ts: TS,
      pid: 7,
      ppid: 1,
      startTime: "",
      hostname: "h",
      agentVersion: "t",
    } as SessionRecord
    expect(hasOpenAttach([attach])).toBe(true)
    expect(hasOpenAttach([attach, { kind: "detach", ts: TS, pid: 7, reason: "exit" }])).toBe(false)
  })
})
