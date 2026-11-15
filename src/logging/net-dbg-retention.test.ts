import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  DEFAULT_NET_DBG_MAX_AGE_DAYS,
  DEFAULT_NET_DBG_MAX_TOTAL_BYTES,
  type NetDbgEntry,
  planNetDbgPrune,
  pruneNetDbgDir,
  resolveNetDbgRetention,
  sessionDirStartedAt,
} from "./net-dbg-retention.ts"

const DAY = 86_400_000
const NOW = 1_794_800_000_000
const name = (epoch: number, sid = "aaaa-bbbb") =>
  `${epoch}-15-NOV-2026-SUNDAY--13h39m42s-0500-minimal-agent-${sid}`
/** An entry started `ageDays` ago; idle since then unless `activeDaysAgo` says otherwise. */
const e = (ageDays: number, bytes: number, sid?: string, activeDaysAgo = ageDays): NetDbgEntry => ({
  name: name(NOW - ageDays * DAY, sid ?? String(ageDays)),
  startedAt: NOW - ageDays * DAY,
  lastActivityAt: NOW - activeDaysAgo * DAY,
  bytes,
})
const MIN = 60_000

describe("sessionDirStartedAt", () => {
  it("reads the leading epoch of a session folder name", () => {
    expect(sessionDirStartedAt(name(1_794_767_982_042))).toBe(1_794_767_982_042)
  })
  it("rejects anything that is not a session folder", () => {
    expect(sessionDirStartedAt("notes.txt")).toBeUndefined()
    expect(sessionDirStartedAt("12345-minimal-agent-x")).toBeUndefined()
    expect(sessionDirStartedAt(`${name(NOW)}/..`)).toBeUndefined()
  })
})

describe("resolveNetDbgRetention", () => {
  it("fills defaults", () => {
    expect(resolveNetDbgRetention(undefined)).toEqual({
      maxAgeDays: DEFAULT_NET_DBG_MAX_AGE_DAYS,
      maxTotalBytes: DEFAULT_NET_DBG_MAX_TOTAL_BYTES,
    })
  })
  it("converts MB and keeps 0 as off", () => {
    expect(resolveNetDbgRetention({ maxAgeDays: 0, maxTotalMB: 1 })).toEqual({
      maxAgeDays: 0,
      maxTotalBytes: 1024 ** 2,
    })
  })
})

describe("planNetDbgPrune", () => {
  it("drops folders past the age limit, oldest first", () => {
    const entries = [e(1, 10), e(30, 10), e(8, 10)]
    expect(planNetDbgPrune(entries, { maxAgeDays: 7, maxTotalBytes: 0 }, NOW)).toEqual([
      entries[1]!.name,
      entries[2]!.name,
    ])
  })

  it("then drops the oldest until the rest fit the size budget", () => {
    const entries = [e(3, 100), e(2, 100), e(1, 100), e(0, 100)]
    // 400 total, budget 250 → drop the two oldest.
    expect(planNetDbgPrune(entries, { maxAgeDays: 0, maxTotalBytes: 250 }, NOW)).toEqual([
      entries[0]!.name,
      entries[1]!.name,
    ])
  })

  it("never picks the live folder, even when over every limit", () => {
    const live = e(30, 10_000)
    const old = e(29, 10)
    expect(
      planNetDbgPrune([live, old], { maxAgeDays: 7, maxTotalBytes: 1 }, NOW, live.name),
    ).toEqual([old.name])
  })

  it("ages and ranks by last activity, not by the start epoch in the name", () => {
    // Started 30 days ago but wrote 2 days ago: younger than a folder started
    // and last written 5 days ago.
    const longRunning = e(30, 100, "long", 2)
    const idle = e(5, 100, "idle")
    expect(
      planNetDbgPrune([longRunning, idle], { maxAgeDays: 7, maxTotalBytes: 150 }, NOW),
    ).toEqual([idle.name])
  })

  it("never picks a folder active within the grace window (a live peer), under either rule", () => {
    // Nathan's case: the oldest-named folders are long-running live sessions.
    const livePeer: NetDbgEntry = { ...e(30, 10_000, "peer"), lastActivityAt: NOW - 2 * MIN }
    const idle = e(3, 10)
    const plan = planNetDbgPrune([livePeer, idle], { maxAgeDays: 7, maxTotalBytes: 1 }, NOW)
    expect(plan).toEqual([idle.name])
    // Just past the grace window it becomes a normal candidate again.
    const stale: NetDbgEntry = { ...livePeer, lastActivityAt: NOW - 61 * MIN }
    expect(planNetDbgPrune([stale], { maxAgeDays: 0, maxTotalBytes: 1 }, NOW)).toEqual([stale.name])
  })

  it("both limits off: nothing to do", () => {
    expect(planNetDbgPrune([e(400, 1e12)], { maxAgeDays: 0, maxTotalBytes: 0 }, NOW)).toEqual([])
  })
})

describe("pruneNetDbgDir", () => {
  let root = ""
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ma-netdbg-ret-"))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A session folder started `ageDays` ago whose files were last written `activeDaysAgo` ago. */
  function mk(ageDays: number, bytes: number, sid: string, activeDaysAgo = ageDays): string {
    const n = name(NOW - ageDays * DAY, sid)
    mkdirSync(join(root, n, "sub"), { recursive: true })
    writeFileSync(join(root, n, "a.txt"), "x".repeat(bytes - 1))
    writeFileSync(join(root, n, "sub", "b.txt"), "y")
    const t = new Date(NOW - activeDaysAgo * DAY)
    for (const p of [
      join(root, n, "sub", "b.txt"),
      join(root, n, "a.txt"),
      join(root, n, "sub"),
      join(root, n),
    ]) {
      utimesSync(p, t, t)
    }
    return n
  }

  it("deletes the planned folders, sums sizes recursively, leaves strangers", async () => {
    const old = mk(10, 50, "old")
    const mid = mk(3, 50, "mid")
    const live = mk(0, 50, "live")
    writeFileSync(join(root, "README.txt"), "keep me")
    mkdirSync(join(root, "not-a-session"))

    const r = await pruneNetDbgDir(
      root,
      { maxAgeDays: 7, maxTotalBytes: 60 },
      { now: NOW, keep: live },
    )
    expect(r).toEqual({ removed: 2, freedBytes: 100, keptBytes: 50 })
    expect(existsSync(join(root, old))).toBe(false)
    expect(existsSync(join(root, mid))).toBe(false)
    expect(readdirSync(root).sort()).toEqual([live, "README.txt", "not-a-session"].sort())
  })

  it("reads last activity from the newest file, so an appended-to old folder survives", async () => {
    // Old name and old folder mtime, but one file was just appended (how a
    // live capture writes): the folder mtime does not move, the file's does.
    const live = mk(30, 50, "live-peer")
    const fresh = new Date(NOW - 5 * MIN)
    utimesSync(join(root, live, "sub", "b.txt"), fresh, fresh)
    const idle = mk(10, 50, "idle")
    const r = await pruneNetDbgDir(root, { maxAgeDays: 7, maxTotalBytes: 1 }, { now: NOW })
    expect(r.removed).toBe(1)
    expect(existsSync(join(root, live))).toBe(true)
    expect(existsSync(join(root, idle))).toBe(false)
  })

  it("is a no-op for a missing directory", async () => {
    expect(await pruneNetDbgDir(join(root, "nope"), { maxAgeDays: 1, maxTotalBytes: 1 })).toEqual({
      removed: 0,
      freedBytes: 0,
      keptBytes: 0,
    })
  })
})
