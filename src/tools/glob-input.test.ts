import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import {
  globPathFromInput,
  globPatternFromInput,
  jsonTypeName,
  resolveGlobExecArgs,
} from "./glob-input.ts"
import { globArgNotStringResult, globMissingPatternResult } from "./PROMPTS.ts"
import { _setGlobTimeoutMsForTests, executeTool, TOOL_DEFINITIONS } from "./tools.ts"

describe("jsonTypeName", () => {
  it("names null and arrays distinctly from object", () => {
    expect(jsonTypeName(null)).toBe("null")
    expect(jsonTypeName([])).toBe("array")
    expect(jsonTypeName({})).toBe("object")
    expect(jsonTypeName(1)).toBe("number")
    expect(jsonTypeName("x")).toBe("string")
  })
})

describe("globPatternFromInput", () => {
  it("reads canonical `pattern`", () => {
    expect(globPatternFromInput({ pattern: "**/*.ts" })).toEqual({
      status: "ok",
      key: "pattern",
      value: "**/*.ts",
    })
  })

  it("reads Cursor alias `glob_pattern`", () => {
    expect(globPatternFromInput({ glob_pattern: "src/lib/*.test.ts" })).toEqual({
      status: "ok",
      key: "glob_pattern",
      value: "src/lib/*.test.ts",
    })
  })

  it("prefers `pattern` when both are set", () => {
    expect(globPatternFromInput({ pattern: "canonical/*.ts", glob_pattern: "alias/*.ts" })).toEqual(
      {
        status: "ok",
        key: "pattern",
        value: "canonical/*.ts",
      },
    )
  })

  it("skips empty `pattern` and uses the alias", () => {
    expect(globPatternFromInput({ pattern: "", glob_pattern: "*.md" })).toEqual({
      status: "ok",
      key: "glob_pattern",
      value: "*.md",
    })
  })

  it("reports missing when neither key is a non-empty string", () => {
    expect(globPatternFromInput({})).toEqual({ status: "missing" })
    expect(globPatternFromInput({ pattern: "" })).toEqual({ status: "missing" })
    expect(globPatternFromInput({ pattern: null })).toEqual({ status: "missing" })
  })

  it("rejects a non-string at the first listed key without falling through", () => {
    expect(globPatternFromInput({ pattern: 12, glob_pattern: "*.ts" })).toEqual({
      status: "invalid",
      key: "pattern",
      got: "number",
    })
  })
})

describe("globPathFromInput", () => {
  it("reads canonical `path` and alias `target_directory`", () => {
    expect(globPathFromInput({ path: "/src" })).toEqual({
      status: "ok",
      key: "path",
      value: "/src",
    })
    expect(globPathFromInput({ target_directory: "/tmp" })).toEqual({
      status: "ok",
      key: "target_directory",
      value: "/tmp",
    })
  })

  it("prefers `path` when both are set", () => {
    expect(globPathFromInput({ path: "/canonical", target_directory: "/alias" })).toEqual({
      status: "ok",
      key: "path",
      value: "/canonical",
    })
  })
})

describe("resolveGlobExecArgs", () => {
  it("fills searchPath from the alias and default cwd", () => {
    expect(resolveGlobExecArgs({ glob_pattern: "*.ts", target_directory: "/src" }, "/cwd")).toEqual(
      {
        ok: true,
        pattern: "*.ts",
        searchPath: "/src",
      },
    )
    expect(resolveGlobExecArgs({ pattern: "*.md" }, "/cwd")).toEqual({
      ok: true,
      pattern: "*.md",
      searchPath: "/cwd",
    })
  })

  it("returns the PROMPTS error copy for missing or mistyped args", () => {
    expect(resolveGlobExecArgs({}, "/cwd")).toEqual({
      ok: false,
      error: globMissingPatternResult(),
    })
    expect(resolveGlobExecArgs({ pattern: 1 }, "/cwd")).toEqual({
      ok: false,
      error: globArgNotStringResult("pattern", "number"),
    })
  })
})

describe("GLOB_TOOL schema", () => {
  const glob = TOOL_DEFINITIONS.find((t) => t.name === "Glob")
  if (!glob) throw new Error("Glob tool missing from TOOL_DEFINITIONS")
  const props = glob.input_schema.properties as Record<
    string,
    { type?: string; description?: string }
  >

  it("documents pattern plus Cursor aliases, and keeps additionalProperties false", () => {
    expect(Object.keys(props)).toEqual(["pattern", "glob_pattern", "path", "target_directory"])
    expect(props.pattern?.type).toBe("string")
    expect(props.glob_pattern?.type).toBe("string")
    expect(props.path?.type).toBe("string")
    expect(props.target_directory?.type).toBe("string")
    expect(props.pattern?.description).toMatch(/glob_pattern/)
    expect(props.glob_pattern?.description).toMatch(/alias/i)
    expect(props.path?.description).toMatch(/target_directory/)
    expect(props.target_directory?.description).toMatch(/alias/i)
    expect(glob.input_schema.required).toEqual(["pattern"])
    expect(glob.input_schema.additionalProperties).toBe(false)
  })
})

describe("executeTool Glob", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tools-glob-"))
    mkdirSync(join(dir, "src", "lib"), { recursive: true })
    writeFileSync(join(dir, "src", "lib", "a.test.ts"), "export {}\n")
    writeFileSync(join(dir, "src", "lib", "b.ts"), "export {}\n")
    writeFileSync(join(dir, "README.md"), "# hi\n")
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("matches with canonical `pattern` + `path`", async () => {
    const r = await executeTool("Glob", { pattern: "src/lib/*.ts", path: dir })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("src/lib/a.test.ts")
    expect(r.content).toContain("src/lib/b.ts")
    expect(r.content).not.toContain("README.md")
  })

  it("matches with Cursor `glob_pattern` + `target_directory`", async () => {
    const r = await executeTool("Glob", {
      glob_pattern: "src/lib/*.test.ts",
      target_directory: dir,
    })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe("src/lib/a.test.ts")
  })

  it("does not throw Glob.constructor when pattern is missing", async () => {
    const r = await executeTool("Glob", {})
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(globMissingPatternResult())
    expect(r.content).not.toMatch(/constructor/i)
  })

  it("does not throw Glob.constructor when pattern is not a string", async () => {
    const r = await executeTool("Glob", { pattern: ["**/*.ts"] })
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(globArgNotStringResult("pattern", "array"))
    expect(r.content).not.toMatch(/constructor/i)
  })

  it("rejects a non-string path alias without scanning", async () => {
    const r = await executeTool("Glob", { pattern: "*.ts", target_directory: 1 })
    expect(r.is_error).toBe(true)
    expect(r.content).toBe(globArgNotStringResult("target_directory", "number"))
  })

  it("returns the no-match copy for a valid pattern with no hits", async () => {
    const r = await executeTool("Glob", { pattern: "does-not-exist-*.xyz", path: dir })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toBe("No files matched the pattern.")
  })
})

describe("executeTool Glob resilience", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tools-glob-res-"))
  })
  // Reset per test: a deadline override in one case must not leak into the next.
  beforeEach(() => {
    _setGlobTimeoutMsForTests()
    delete process.env.GLOB_PRUNE
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    _setGlobTimeoutMsForTests()
    delete process.env.GLOB_PRUNE
  })

  /**
   * Build `levels` nested directories, each holding `perLevel` matches.
   * Deep enough that a walk of it costs real time, so a deadline can fire.
   */
  function buildTree(root: string, levels: number, perLevel: number): void {
    let rel = ""
    for (let i = 0; i < levels; i++) {
      rel = rel === "" ? `d${i}` : `${rel}/d${i}`
      mkdirSync(join(root, rel), { recursive: true })
      for (let j = 0; j < perLevel; j++) {
        writeFileSync(join(root, rel, `hit${j}.py`), "")
      }
    }
  }

  it("keeps matches from readable directories when one directory is unreadable", async () => {
    // Regression: `Bun.Glob.scan` throws on the first unreadable directory and
    // discards the whole iteration, so a single EPERM returned a bare error and
    // zero matches. The walk must skip the bad directory and keep the rest.
    const root = join(dir, "eperm")
    mkdirSync(join(root, "good", "deep"), { recursive: true })
    mkdirSync(join(root, "locked", "inner"), { recursive: true })
    writeFileSync(join(root, "good", "deep", "found.py"), "")
    writeFileSync(join(root, "locked", "inner", "hidden.py"), "")

    const lockedDir = join(root, "locked")
    const mode = 0o000
    chmodSync(lockedDir, mode)
    try {
      const r = await executeTool("Glob", { pattern: "**/*.py", path: root })
      // The readable match survives even though `locked` could not be read.
      expect(r.is_error).toBeFalsy()
      expect(r.content).toContain("good/deep/found.py")
      // And the caller is told the result is partial.
      expect(r.content).toMatch(/skipped 1 unreadable directory/)
    } finally {
      // Restore so afterAll's rmSync can remove the tree.
      chmodSync(lockedDir, 0o755)
    }
  })

  it("stops at the deadline and returns partial results with a notice", async () => {
    const root = join(dir, "slow")
    buildTree(root, 3, 1)
    // A zero budget fires before the first directory is read.
    _setGlobTimeoutMsForTests(0)
    const startedAt = Date.now()
    const r = await executeTool("Glob", { pattern: "**/*.py", path: root })
    const elapsed = Date.now() - startedAt
    expect(r.is_error).toBeFalsy()
    expect(r.content).toMatch(/glob stopped after 0ms/)
    expect(r.content).toMatch(/partial results/)
    // A bare budget must not hang: it returns at the first deadline check.
    expect(elapsed).toBeLessThan(2_000)
  })

  it("prunes node_modules unless the pattern names it", async () => {
    const root = join(dir, "prune")
    mkdirSync(join(root, "src"), { recursive: true })
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(root, "src", "app.py"), "")
    writeFileSync(join(root, "node_modules", "pkg", "dep.py"), "")

    const pruned = await executeTool("Glob", { pattern: "**/*.py", path: root })
    expect(pruned.content).toContain("src/app.py")
    expect(pruned.content).not.toContain("node_modules")

    // Opting out restores the old, unpruned traversal for parity.
    process.env.GLOB_PRUNE = "false"
    try {
      const full = await executeTool("Glob", { pattern: "**/*.py", path: root })
      expect(full.content).toContain("node_modules/pkg/dep.py")
    } finally {
      delete process.env.GLOB_PRUNE
    }
  })

  it("matches Bun.Glob.scan exactly for the same pattern and tree", async () => {
    // Parity guard: the walk reimplements traversal, so any drift from the
    // documented `Bun.Glob` semantics (dot:false, onlyFiles:false, ordering)
    // must surface here rather than as a silent behavior change.
    const root = join(dir, "parity")
    mkdirSync(join(root, "a", "b", "c"), { recursive: true })
    mkdirSync(join(root, "a", "x"), { recursive: true })
    mkdirSync(join(root, ".hidden", "q"), { recursive: true })
    writeFileSync(join(root, "a", "b", "c", "t.ts"), "")
    writeFileSync(join(root, "a", "x", "t.ts"), "")
    writeFileSync(join(root, "a", "t.ts"), "")
    writeFileSync(join(root, "t.ts"), "")
    writeFileSync(join(root, ".dotfile.ts"), "")
    writeFileSync(join(root, ".hidden", "q", "t.ts"), "")

    for (const pattern of ["**/*.ts", "**/t.ts", "a/**/*.ts", "a/*.ts", "**/*"]) {
      const expected: string[] = []
      for await (const entry of new Bun.Glob(pattern).scan({
        cwd: root,
        onlyFiles: false,
        dot: false,
      })) {
        expected.push(entry)
      }
      expected.sort()

      const r = await executeTool("Glob", { pattern, path: root })
      const got = r.content.split("\n").filter((line) => line !== "")
      if (expected.length === 0) {
        expect(r.content).toBe("No files matched the pattern.")
        continue
      }
      expect(got).toEqual(expected)
    }
  })

  it("yields to the event loop so the TUI keeps painting during a walk", async () => {
    // A synchronous walk (readdirSync) would hold the event loop for the whole
    // traversal, freezing the UI. The async walk awaits each directory, so a
    // timer armed before the walk must tick while it runs. The tree is wide
    // enough (320 directories) that the walk spans several timer turns; a
    // depth-only tree of a few dirs finishes inside one turn and proves nothing.
    const root = join(dir, "yield")
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 8; j++) {
        const sub = join(root, `d${i}`, `s${j}`)
        mkdirSync(sub, { recursive: true })
        writeFileSync(join(sub, "hit.py"), "")
      }
    }

    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 0)
    const startedAt = Date.now()
    try {
      await executeTool("Glob", { pattern: "**/*.py", path: root })
    } finally {
      clearInterval(timer)
    }
    // Guard the assertion's premise: if the walk finished instantly the timer
    // could not have ticked, and the check would be vacuous.
    expect(Date.now() - startedAt).toBeGreaterThan(0)
    expect(ticks).toBeGreaterThan(0)
  })
})
