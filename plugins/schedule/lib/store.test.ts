/**
 * Tests for the per-session cron task store.
 *
 * @module schedule/lib/store.test
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { type CronEntry, CronStore, MAX_TASKS, SEVEN_DAYS_MS } from "./store.ts"

let dir: string
const SID = "test-session"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-cron-store-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function store(): CronStore {
  // Deterministic LCG so ids are stable across runs yet have enough
  // entropy to mint 50 distinct ones without collision.
  let seed = 0x2545f4
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  return new CronStore(SID, { dir, rand })
}

describe("CronStore — CRUD", () => {
  it("creates, loads, gets, deletes", () => {
    const s = store()
    const r = s.create({ cron: "*/5 * * * *", prompt: "check deploy", recurs: true }, 1_000)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const id = r.value.id
    expect(id).toMatch(/^[0-9a-z]{8}$/)
    expect(s.count()).toBe(1)
    expect(s.get(id)).toMatchObject({ cron: "*/5 * * * *", prompt: "check deploy", recurs: true })
    expect(s.delete(id)).toBe(true)
    expect(s.delete(id)).toBe(false)
    expect(s.count()).toBe(0)
  })

  it("sets a 7-day expiry on recurring tasks only", () => {
    const s = store()
    const rec = s.create({ cron: "*/5 * * * *", prompt: "p", recurs: true }, 1_000)
    const once = s.create({ cron: "0 9 * * *", prompt: "p", recurs: false }, 1_000)
    expect(rec.ok && rec.value.expiresAt).toBe(1_000 + SEVEN_DAYS_MS)
    expect(once.ok && once.value.expiresAt).toBeUndefined()
  })

  it("persists pace + nextAtMs + label + source", () => {
    const s = store()
    const r = s.create(
      {
        cron: "* * * * *",
        prompt: "p",
        recurs: true,
        pace: "dynamic",
        nextAtMs: 5_000,
        label: "self-paced",
        source: "loop",
      },
      1_000,
    )
    expect(r.ok && r.value).toMatchObject({
      pace: "dynamic",
      nextAtMs: 5_000,
      label: "self-paced",
      source: "loop",
    })
  })
})

describe("CronStore — capacity", () => {
  it("rejects creation past MAX_TASKS", () => {
    const s = store()
    for (let i = 0; i < MAX_TASKS; i++) {
      const r = s.create({ cron: "* * * * *", prompt: `p${i}`, recurs: true })
      expect(r.ok).toBe(true)
    }
    expect(s.count()).toBe(MAX_TASKS)
    const over = s.create({ cron: "* * * * *", prompt: "too many", recurs: true })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toMatch(/limit reached/)
  })
})

describe("CronStore — persistence", () => {
  it("survives a fresh store instance (resume)", () => {
    const a = store()
    a.create({ cron: "*/5 * * * *", prompt: "survives", recurs: true }, 1_000)
    const b = new CronStore(SID, { dir })
    expect(b.count()).toBe(1)
    expect(b.load()[0]?.prompt).toBe("survives")
  })

  it("deletes the file when the last task is removed", () => {
    const s = store()
    const r = s.create({ cron: "* * * * *", prompt: "p", recurs: true })
    expect(existsSync(s.path)).toBe(true)
    if (r.ok) s.delete(r.value.id)
    expect(existsSync(s.path)).toBe(false)
  })

  it("tolerates a malformed file (returns [])", () => {
    const s = store()
    writeFileSync(s.path, "{ not json")
    expect(s.load()).toEqual([])
  })

  it("drops malformed entries but keeps good ones", () => {
    const s = store()
    const good: CronEntry = {
      id: "abcd1234",
      cron: "* * * * *",
      prompt: "ok",
      recurs: true,
      pace: "fixed",
      createdAt: 1,
    }
    writeFileSync(s.path, JSON.stringify([good, { id: 5 }, null, { cron: "x" }]))
    const loaded = s.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.id).toBe("abcd1234")
  })

  it("writes pretty JSON array", () => {
    const s = store()
    s.create({ cron: "* * * * *", prompt: "p", recurs: true }, 1_000)
    const raw = readFileSync(s.path, "utf-8")
    expect(raw.startsWith("[")).toBe(true)
    expect(JSON.parse(raw)).toHaveLength(1)
  })
})
