import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import { getDiagnosticBus } from "../bus/diagnostic-bus.ts"

import { isIgnored, type JsGrepParams, jsGrep, parseIgnoreFile } from "./grep-js.ts"
import { _setGrepRgResolverForTests, executeTool } from "./tools.ts"

const OPTS = { maxBytes: 512 * 1024, timeoutMs: 30_000 }

let root: string

/** Write a file, creating parent dirs. */
function put(rel: string, body: string | Uint8Array): void {
  const p = join(root, rel)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, body)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "grep-js-"))
  // A git work tree so .gitignore applies (a `.git` dir is enough).
  mkdirSync(join(root, ".git"))
  put(".gitignore", "build/\n*.log\n!keep.log\n/rooted.txt\n")
  put("a.txt", "foo\nbar\nfoo baz\n")
  put("ctx.txt", "one\ntwo\nfoo\nthree\nfour\nfive\nfoo\n")
  put("sub/b.ts", "x\nfoo\n")
  put("sub/rooted.txt", "foo\n") // not ignored: `/rooted.txt` is anchored to the root
  put("rooted.txt", "foo\n")
  put("build/out.txt", "foo\n")
  put("debug.log", "foo\n")
  put("keep.log", "foo\n")
  put(".hidden/c.txt", "foo\n")
  put(".dotfile", "foo\n")
  put("bin.dat", new Uint8Array([102, 111, 111, 0, 1, 2]))
  put("Upper.md", "FOO\n")
  put("multi.txt", "start\nfoo\nbar\nend\n")
  symlinkSync(join(root, "a.txt"), join(root, "link.txt"))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Run jsGrep and return its stdout lines (or the outcome kind). */
async function run(p: Partial<JsGrepParams> & { pattern: string }): Promise<string[] | string> {
  const r = await jsGrep({ searchPath: root, outputMode: "files_with_matches", ...p }, OPTS)
  return r.kind === "ok" ? r.stdout.split("\n") : r.kind
}

describe("jsGrep: walk and ignore rules", () => {
  it("lists matching files, skipping hidden, ignored, binary, and symlinked entries", async () => {
    expect(await run({ pattern: "foo" })).toEqual([
      `${root}/a.txt`,
      `${root}/ctx.txt`,
      `${root}/keep.log`,
      `${root}/multi.txt`,
      `${root}/sub/b.ts`,
      `${root}/sub/rooted.txt`,
    ])
  })

  it("applies --glob to the basename, and `!` excludes", async () => {
    expect(await run({ pattern: "foo", glob: "*.ts" })).toEqual([`${root}/sub/b.ts`])
    const excluded = await run({ pattern: "foo", glob: "!*.txt" })
    expect(excluded).toEqual([`${root}/keep.log`, `${root}/sub/b.ts`])
  })

  it("applies a --glob with a slash to the relative path", async () => {
    expect(await run({ pattern: "foo", glob: "sub/**" })).toEqual([
      `${root}/sub/b.ts`,
      `${root}/sub/rooted.txt`,
    ])
  })

  it("ignores .gitignore outside a git work tree but honors .ignore", async () => {
    const plain = mkdtempSync(join(tmpdir(), "grep-js-plain-"))
    try {
      writeFileSync(join(plain, ".gitignore"), "a.txt\n")
      writeFileSync(join(plain, ".ignore"), "b.txt\n")
      writeFileSync(join(plain, "a.txt"), "hit\n")
      writeFileSync(join(plain, "b.txt"), "hit\n")
      const r = await jsGrep(
        { pattern: "hit", searchPath: plain, outputMode: "files_with_matches" },
        OPTS,
      )
      expect(r).toEqual({ kind: "ok", stdout: `${plain}/a.txt`, capped: false })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it("honors an ancestor .gitignore when searching a subdirectory", async () => {
    put("sub/deep/ignored.log", "foo\n")
    const r = await jsGrep(
      { pattern: "foo", searchPath: join(root, "sub"), outputMode: "files_with_matches" },
      OPTS,
    )
    expect(r.kind === "ok" && r.stdout.includes("ignored.log")).toBe(false)
  })
})

describe("jsGrep: output modes", () => {
  it("count mode prints path:N, and bare N for a single file", async () => {
    expect(await run({ pattern: "foo", outputMode: "count", glob: "a.txt" })).toEqual([
      `${root}/a.txt:2`,
    ])
    const single = await jsGrep(
      { pattern: "foo", searchPath: join(root, "a.txt"), outputMode: "count" },
      OPTS,
    )
    expect(single).toEqual({ kind: "ok", stdout: "2", capped: false })
  })

  it("content mode prints path:line:text", async () => {
    expect(await run({ pattern: "foo", outputMode: "content", glob: "a.txt" })).toEqual([
      `${root}/a.txt:1:foo`,
      `${root}/a.txt:3:foo baz`,
    ])
  })

  it("content mode on a single file drops the path prefix", async () => {
    const r = await jsGrep(
      { pattern: "foo", searchPath: join(root, "a.txt"), outputMode: "content" },
      OPTS,
    )
    expect(r).toEqual({ kind: "ok", stdout: "1:foo\n3:foo baz", capped: false })
  })

  it("context lines use `-`, and `--` separates non-adjacent groups and files", async () => {
    const r = await run({
      pattern: "foo",
      outputMode: "content",
      glob: "{a,ctx}.txt",
      before: 1,
      after: 1,
    })
    expect(r).toEqual([
      `${root}/a.txt:1:foo`,
      `${root}/a.txt-2-bar`,
      `${root}/a.txt:3:foo baz`,
      "--",
      `${root}/ctx.txt-2-two`,
      `${root}/ctx.txt:3:foo`,
      `${root}/ctx.txt-4-three`,
      "--",
      `${root}/ctx.txt-6-five`,
      `${root}/ctx.txt:7:foo`,
    ])
  })

  it("-i matches case-insensitively", async () => {
    expect(await run({ pattern: "foo", caseInsensitive: true, glob: "*.md" })).toEqual([
      `${root}/Upper.md`,
    ])
    expect(await run({ pattern: "foo", glob: "*.md" })).toBe("no-match")
  })

  it("multiline lets `.` cross newlines and reports every spanned line", async () => {
    const r = await run({
      pattern: "foo.bar",
      multiline: true,
      outputMode: "content",
      glob: "multi.txt",
    })
    expect(r).toEqual([`${root}/multi.txt:2:foo`, `${root}/multi.txt:3:bar`])
    expect(await run({ pattern: "foo.bar", glob: "multi.txt" })).toBe("no-match")
  })
})

describe("jsGrep: failures", () => {
  it("reports a bad regex as an error", async () => {
    const r = await jsGrep({ pattern: "(", searchPath: root, outputMode: "content" }, OPTS)
    expect(r.kind).toBe("error")
  })

  it("reports a missing path as an error", async () => {
    const r = await jsGrep(
      { pattern: "x", searchPath: join(root, "nope"), outputMode: "content" },
      OPTS,
    )
    expect(r.kind).toBe("error")
  })

  it("returns aborted when the signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await jsGrep(
      { pattern: "foo", searchPath: root, outputMode: "content" },
      { ...OPTS, signal: ac.signal },
    )
    expect(r.kind).toBe("aborted")
  })

  it("returns timeout past the wall-clock budget", async () => {
    let t = 0
    const r = await jsGrep(
      { pattern: "foo", searchPath: root, outputMode: "content" },
      { ...OPTS, timeoutMs: 5, now: () => (t += 10) },
    )
    expect(r.kind).toBe("timeout")
  })

  it("stops at maxBytes and flags the result as capped", async () => {
    const r = await jsGrep(
      { pattern: "foo", searchPath: root, outputMode: "content" },
      { ...OPTS, maxBytes: 10 },
    )
    expect(r.kind === "ok" && r.capped).toBe(true)
  })
})

describe("ignore-file parsing", () => {
  it("supports negation, dir-only and anchored rules", () => {
    const rules = parseIgnoreFile("# c\n\n*.log\n!keep.log\nout/\n/top.txt\n", "/r")
    expect(isIgnored(rules, "/r/x.log", false)).toBe(true)
    expect(isIgnored(rules, "/r/keep.log", false)).toBe(false)
    expect(isIgnored(rules, "/r/out", true)).toBe(true)
    expect(isIgnored(rules, "/r/out", false)).toBe(false)
    expect(isIgnored(rules, "/r/top.txt", false)).toBe(true)
    expect(isIgnored(rules, "/r/a/top.txt", false)).toBe(false)
  })
})

describe("Grep tool without rg", () => {
  afterEach(() => _setGrepRgResolverForTests())

  it("falls back to the JS search with the same result shape, and logs once", async () => {
    _setGrepRgResolverForTests(() => null)
    const seen: string[] = []
    const off = getDiagnosticBus().on("*", (e) => {
      if (e.source === "tools.grep.fallback") seen.push(e.message)
    })
    try {
      const r1 = await executeTool("Grep", { pattern: "foo", path: root, glob: "*.ts" })
      expect(r1.is_error).toBeFalsy()
      expect(r1.content).toBe(`${root}/sub/b.ts`)
      const r2 = await executeTool("Grep", { pattern: "zzz-none", path: root })
      expect(r2.content).toBe("No matches found.")
      const r3 = await executeTool("Grep", { pattern: "(", path: root })
      expect(r3.is_error).toBe(true)
      expect(r3.content).toStartWith("Grep error:")
      const r4 = await executeTool("Grep", {
        pattern: "foo",
        path: root,
        output_mode: "content",
        glob: "ctx.txt",
        head_limit: 1,
      })
      expect(r4.content).toStartWith(`${root}/ctx.txt:3:foo`)
      expect(seen).toHaveLength(1)
    } finally {
      off()
    }
  })

  it.skipIf(!Bun.which("rg"))("matches real rg output on the fixture tree", async () => {
    const cases: Array<Record<string, unknown>> = [
      { pattern: "foo" },
      { pattern: "foo", output_mode: "count" },
      { pattern: "foo", output_mode: "content" },
      { pattern: "foo", output_mode: "content", "-C": 1 },
      { pattern: "FOO", "-i": true },
      { pattern: "foo", glob: "*.ts" },
      { pattern: "foo", path: join(root, "a.txt"), output_mode: "content" },
    ]
    for (const c of cases) {
      const input = { path: root, ...c }
      _setGrepRgResolverForTests()
      const viaRg = await executeTool("Grep", input)
      _setGrepRgResolverForTests(() => null)
      const viaJs = await executeTool("Grep", input)
      // rg's file order is not sorted; compare per-file blocks as sets.
      const norm = (s: string): string[] => s.split("\n--\n").sort()
      const blocks = (s: string): string[] =>
        c.output_mode === "content" && c["-C"] ? norm(s) : s.split("\n").sort()
      expect(blocks(viaJs.content)).toEqual(blocks(viaRg.content))
    }
  })
})
