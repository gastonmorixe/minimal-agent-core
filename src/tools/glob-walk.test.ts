import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import { _setGlobTimeoutMsForTests, GLOB_MAX_ENTRIES, walkGlobMatches } from "./glob-walk.ts"

describe("walkGlobMatches", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "glob-walk-"))
  })
  afterEach(() => {
    _setGlobTimeoutMsForTests()
    delete process.env.GLOB_PRUNE
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns matches relative to the search root", async () => {
    const root = join(dir, "rel")
    mkdirSync(join(root, "a", "b"), { recursive: true })
    writeFileSync(join(root, "a", "b", "x.ts"), "")
    writeFileSync(join(root, "top.ts"), "")
    const r = await walkGlobMatches("**/*.ts", root, undefined)
    expect(r.entries.sort()).toEqual(["a/b/x.ts", "top.ts"])
    expect(r.timedOut).toBe(false)
    expect(r.skippedDirs).toBe(0)
  })

  it("never matches or descends into leading-dot entries", async () => {
    const root = join(dir, "dot")
    mkdirSync(join(root, ".cache"), { recursive: true })
    writeFileSync(join(root, ".hidden.ts"), "")
    writeFileSync(join(root, ".cache", "inner.ts"), "")
    writeFileSync(join(root, "shown.ts"), "")
    const r = await walkGlobMatches("**/*.ts", root, undefined)
    expect(r.entries).toEqual(["shown.ts"])
  })

  it("skips an unreadable directory, counts it, and keeps other matches", async () => {
    const root = join(dir, "unreadable")
    mkdirSync(join(root, "ok"), { recursive: true })
    mkdirSync(join(root, "blocked", "deep"), { recursive: true })
    writeFileSync(join(root, "ok", "kept.ts"), "")
    writeFileSync(join(root, "blocked", "deep", "lost.ts"), "")
    const blocked = join(root, "blocked")
    chmodSync(blocked, 0o000)
    try {
      const r = await walkGlobMatches("**/*.ts", root, undefined)
      // The readable match survives; the walk does not throw.
      expect(r.entries).toEqual(["ok/kept.ts"])
      expect(r.skippedDirs).toBe(1)
      expect(r.timedOut).toBe(false)
    } finally {
      chmodSync(blocked, 0o755)
    }
  })

  it("does not descend into node_modules by default and does when pruning is off", async () => {
    const root = join(dir, "prune")
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(root, "src", "keep.ts"), "")
    writeFileSync(join(root, "node_modules", "pkg", "skip.ts"), "")

    const pruned = await walkGlobMatches("**/*.ts", root, undefined)
    expect(pruned.entries).toEqual(["src/keep.ts"])

    process.env.GLOB_PRUNE = "false"
    const full = await walkGlobMatches("**/*.ts", root, undefined)
    expect(full.entries.sort()).toEqual(["node_modules/pkg/skip.ts", "src/keep.ts"])
  })

  it("honors an already-aborted signal without walking", async () => {
    const root = join(dir, "aborted")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "x.ts"), "")
    const controller = new AbortController()
    controller.abort()
    const r = await walkGlobMatches("**/*.ts", root, controller.signal)
    expect(r.aborted).toBe(true)
    expect(r.entries).toEqual([])
  })

  it("stops at the deadline, reporting the budget it used", async () => {
    const root = join(dir, "deadline")
    mkdirSync(join(root, "a"), { recursive: true })
    writeFileSync(join(root, "a", "x.ts"), "")
    _setGlobTimeoutMsForTests(0)
    const r = await walkGlobMatches("**/*.ts", root, undefined)
    expect(r.timedOut).toBe(true)
    expect(r.budgetMs).toBe(0)
  })

  it("caps the match list at the documented maximum", async () => {
    const root = join(dir, "cap")
    mkdirSync(root, { recursive: true })
    const total = GLOB_MAX_ENTRIES + 25
    for (let i = 0; i < total; i++) {
      writeFileSync(join(root, `f${String(i).padStart(4, "0")}.ts`), "")
    }
    const r = await walkGlobMatches("**/*.ts", root, undefined)
    expect(r.entries.length).toBe(GLOB_MAX_ENTRIES)
  })

  it("matches Bun.Glob.scan for the same tree across several patterns", async () => {
    // Parity guard: the walk reimplements traversal, so drift from the
    // documented Bun.Glob semantics must fail here rather than pass silently.
    const root = join(dir, "parity")
    mkdirSync(join(root, "a", "b", "c"), { recursive: true })
    mkdirSync(join(root, "a", "x"), { recursive: true })
    mkdirSync(join(root, ".hidden", "q"), { recursive: true })
    writeFileSync(join(root, "a", "b", "c", "t.ts"), "")
    writeFileSync(join(root, "a", "x", "t.ts"), "")
    writeFileSync(join(root, "a", "t.ts"), "")
    writeFileSync(join(root, "t.ts"), "")
    writeFileSync(join(root, "t.md"), "")

    for (const pattern of ["**/*.ts", "**/t.ts", "a/**/*.ts", "a/*.ts", "**/*", "*.ts"]) {
      const expected: string[] = []
      for await (const entry of new Bun.Glob(pattern).scan({
        cwd: root,
        onlyFiles: false,
        dot: false,
      })) {
        expected.push(entry)
      }
      const got = (await walkGlobMatches(pattern, root, undefined)).entries
      expect(got.sort()).toEqual(expected.sort())
    }
  })
})
