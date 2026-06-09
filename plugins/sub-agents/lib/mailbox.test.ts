import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { type MailMessage, parseMailbox, postMessage, readMailbox, visibleTo } from "./mailbox.ts"

function msg(over: Partial<MailMessage> = {}): MailMessage {
  return { ts: "2026-05-30T12:00:00.000Z", from: "A2", to: "*", kind: "note", body: "hi", ...over }
}

describe("parseMailbox", () => {
  it("parses good lines, skips blanks + corrupt", () => {
    const text = `${JSON.stringify(msg())}\n\n{bad\n${JSON.stringify(msg({ from: "A3" }))}\n`
    const parsed = parseMailbox(text)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((m) => m.from)).toEqual(["A2", "A3"])
  })
})

describe("visibleTo", () => {
  const all = [
    msg({ from: "A2", to: "*", body: "broadcast" }),
    msg({ from: "A3", to: "A2", body: "for A2" }),
    msg({ from: "A4", to: "A5", body: "for A5 only" }),
    msg({ from: "A2", to: "A3", body: "from me to A3" }),
  ]
  it("shows broadcasts, messages to me, and my own posts", () => {
    const seen = visibleTo(all, "A2").map((m) => m.body)
    expect(seen).toEqual(["broadcast", "for A2", "from me to A3"])
    expect(seen).not.toContain("for A5 only")
  })
  it("honors a since cursor", () => {
    const stamped = [
      msg({ to: "*", body: "old", ts: "2026-05-30T12:00:00.000Z" }),
      msg({ to: "*", body: "new", ts: "2026-05-30T12:05:00.000Z" }),
    ]
    expect(visibleTo(stamped, "A2", "2026-05-30T12:01:00.000Z").map((m) => m.body)).toEqual(["new"])
  })
})

describe("post + read round-trip", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-mbox-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("appends and reads back", () => {
    const path = join(dir, "lead.mailbox.jsonl")
    expect(readMailbox(path)).toEqual([])
    postMessage(path, msg({ from: "A2", to: "A3", body: "claiming parser.ts", kind: "claim" }))
    postMessage(path, msg({ from: "A3", to: "*", body: "done with tests" }))
    const all = readMailbox(path)
    expect(all).toHaveLength(2)
    expect(visibleTo(all, "A3").map((m) => m.body)).toEqual([
      "claiming parser.ts",
      "done with tests",
    ])
  })
})
