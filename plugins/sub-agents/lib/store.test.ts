import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  defaultSessionsDir,
  nextId,
  parseRecords,
  SubagentStore,
  serializeRecords,
} from "./store.ts"
import { type SubagentRecord, sessionId, subagentId } from "./types.ts"

function rec(id: string): SubagentRecord {
  return {
    id: subagentId(id),
    sid: sessionId("00000000-0000-4000-8000-000000000000"),
    label: id,
    type: "worker",
    model: "claude-haiku-4-5",
    task: "t",
    isolation: "fresh",
    workspace: "inherit-cwd",
    spawnedAt: "2026-05-30T00:00:00.000Z",
    status: { kind: "queued" },
    depth: 1,
    leadSid: sessionId("11111111-1111-4111-8111-111111111111"),
  }
}

describe("parse / serialize", () => {
  it("round-trips records", () => {
    const records = [rec("A1"), rec("A2")]
    expect(parseRecords(serializeRecords(records))).toEqual(records)
  })

  it("tolerates blank + corrupt lines without dropping good ones", () => {
    const good = JSON.stringify(rec("A1"))
    const text = `\n${good}\n{ not json\n42\n`
    const parsed = parseRecords(text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe(subagentId("A1"))
  })

  it("serializes empty to empty string", () => {
    expect(serializeRecords([])).toBe("")
  })
})

describe("nextId", () => {
  it("is monotonic over the max numeric suffix (stable across removals)", () => {
    expect(nextId([])).toBe(subagentId("A1"))
    expect(nextId([rec("A1"), rec("A2")])).toBe(subagentId("A3"))
    // A2 removed → next is still A3, never reuses A2.
    expect(nextId([rec("A1"), rec("A3")])).toBe(subagentId("A4"))
  })

  it("honors a custom prefix", () => {
    expect(nextId([rec("A5")], "W")).toBe(subagentId("W1"))
  })
})

describe("SubagentStore", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-store-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns empty before any write", () => {
    const store = new SubagentStore("lead-1", { dir })
    expect(store.all()).toEqual([])
    expect(store.get("A1")).toBeNull()
  })

  it("upsert appends new ids and updates existing in place", () => {
    const store = new SubagentStore("lead-1", { dir })
    store.upsert(rec("A1"))
    store.upsert(rec("A2"))
    expect(store.all().map((r) => r.id)).toEqual([subagentId("A1"), subagentId("A2")])

    const updated: SubagentRecord = {
      ...rec("A1"),
      status: { kind: "running", pid: 99, startedAt: "t", progress: { tools: 0, tokens: 0 } },
    }
    store.upsert(updated)
    expect(store.all().map((r) => r.id)).toEqual([subagentId("A1"), subagentId("A2")]) // order preserved
    expect(store.get("A1")?.status.kind).toBe("running")
  })

  it("nextId reflects persisted state", () => {
    const store = new SubagentStore("lead-1", { dir })
    expect(store.nextId()).toBe(subagentId("A1"))
    store.upsert(rec("A1"))
    expect(store.nextId()).toBe(subagentId("A2"))
  })

  it("replaceAll overwrites the whole fleet", () => {
    const store = new SubagentStore("lead-1", { dir })
    store.upsert(rec("A1"))
    store.replaceAll([rec("A9")])
    expect(store.all().map((r) => r.id)).toEqual([subagentId("A9")])
  })
})

describe("defaultSessionsDir", () => {
  it("relocates the sessions dir under MINIMAL_AGENT_HOME (resolver honors the override)", () => {
    const relocated = join(tmpdir(), "subagents-relocate-home")
    expect(defaultSessionsDir({ MINIMAL_AGENT_HOME: relocated } as NodeJS.ProcessEnv)).toBe(
      join(relocated, "sessions"),
    )
  })

  it("falls back to $HOME/.minimal-agent/sessions when no override is set", () => {
    // No MINIMAL_AGENT_HOME in the passed env → resolver uses HOME. Passing an
    // explicit env keeps this assertion robust against the harness's ambient var.
    const home = join(tmpdir(), "subagents-home-fallback")
    expect(defaultSessionsDir({ HOME: home } as NodeJS.ProcessEnv)).toBe(
      join(home, ".minimal-agent", "sessions"),
    )
  })

  it("MINIMAL_AGENT_HOME wins over HOME", () => {
    const override = join(tmpdir(), "subagents-override-wins")
    const home = join(tmpdir(), "subagents-home-loses")
    expect(
      defaultSessionsDir({ MINIMAL_AGENT_HOME: override, HOME: home } as NodeJS.ProcessEnv),
    ).toBe(join(override, "sessions"))
  })
})
