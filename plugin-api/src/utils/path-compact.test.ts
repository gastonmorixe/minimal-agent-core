import { describe, expect, it } from "bun:test"

import {
  formatPathCompact,
  pathCompactVariants,
  relativizePath,
  splitPathForStyle,
} from "./path-compact.ts"
import { displayWidth } from "./term-width.ts"

const HOME = "/Users/me"
const CWD = "/Users/me/proj"
const SAMPLE = "/Users/me/proj/minimal-agent-cli/src/ui/tool-transcript/format.ts"
const OPTS = { cwd: CWD, home: HOME }

describe("relativizePath", () => {
  it("makes a path inside cwd relative without ./", () => {
    expect(relativizePath("/Users/me/proj/src/a.ts", OPTS)).toBe("src/a.ts")
  })

  it("gives . for path === cwd", () => {
    expect(relativizePath("/Users/me/proj", OPTS)).toBe(".")
  })

  it("uses ~ for a path outside cwd but inside home", () => {
    expect(relativizePath("/Users/me/other/b.ts", OPTS)).toBe("~/other/b.ts")
    expect(relativizePath("/Users/me", OPTS)).toBe("~")
  })

  it("keeps a path outside both unchanged", () => {
    expect(relativizePath("/etc/hosts", OPTS)).toBe("/etc/hosts")
  })

  it("matches on a segment boundary, not a prefix", () => {
    expect(relativizePath("/a/bc/x.ts", { cwd: "/a/b" })).toBe("/a/bc/x.ts")
    expect(relativizePath("/Users/meme/x.ts", { home: HOME })).toBe("/Users/meme/x.ts")
  })

  it("normalizes trailing slashes on cwd and home", () => {
    expect(relativizePath("/Users/me/proj/a.ts", { cwd: "/Users/me/proj/" })).toBe("a.ts")
    expect(relativizePath("/Users/me/proj", { cwd: "/Users/me/proj//" })).toBe(".")
    expect(relativizePath("/Users/me/x", { home: "/Users/me/" })).toBe("~/x")
  })

  it("returns a relative input path unchanged", () => {
    expect(relativizePath("src/a.ts", OPTS)).toBe("src/a.ts")
  })

  it("collapses repeated slashes before matching", () => {
    expect(relativizePath("/a//b", {})).toBe("/a/b")
    expect(relativizePath("/Users//me///proj/src//a.ts", OPTS)).toBe("src/a.ts")
    expect(relativizePath("/Users/me//other/b.ts", OPTS)).toBe("~/other/b.ts")
    expect(relativizePath("/Users/me/proj/a.ts", { cwd: "/Users//me/proj" })).toBe("a.ts")
  })

  it("keeps a path absolute when cwd or home is the root /", () => {
    expect(relativizePath("/etc/hosts", { cwd: "/" })).toBe("/etc/hosts")
    expect(relativizePath("/etc/hosts", { home: "/" })).toBe("/etc/hosts")
    expect(relativizePath("/etc/hosts", { cwd: "//", home: "/" })).toBe("/etc/hosts")
    expect(relativizePath("/Users/me/x", { cwd: "/", home: HOME })).toBe("~/x")
  })
})

describe("pathCompactVariants", () => {
  it("lists forms from longest to shortest", () => {
    expect(pathCompactVariants(SAMPLE, OPTS)).toEqual([
      "minimal-agent-cli/src/ui/tool-transcript/format.ts",
      "minimal-agent-cli/s/u/tool-transcript/format.ts",
      "minimal-agent-cli/\u2026/tool-transcript/format.ts",
      "\u2026/tool-transcript/format.ts",
      "format.ts",
    ])
  })

  it("keeps the ~ root and abbreviates dotfiles to 2 chars", () => {
    const v = pathCompactVariants("/Users/me/code/.github/workflows/deep/ci.yml", { home: HOME })
    expect(v[0]).toBe("~/code/.github/workflows/deep/ci.yml")
    expect(v[1]).toBe("~/code/.g/w/deep/ci.yml")
  })

  it("keeps the / root", () => {
    const v = pathCompactVariants("/opt/aaa/bbb/ccc/x.ts")
    expect(v[1]).toBe("/opt/a/b/ccc/x.ts")
  })

  it("strictly shrinks and has no duplicates", () => {
    const v = pathCompactVariants("a/b/c.ts")
    for (let i = 1; i < v.length; i++) expect(displayWidth(v[i])).toBeLessThan(displayWidth(v[i - 1]))
    expect(new Set(v).size).toBe(v.length)
  })

  it("gives one form for a bare basename", () => {
    expect(pathCompactVariants("x.ts")).toEqual(["x.ts"])
  })
})

describe("formatPathCompact", () => {
  it("returns the relativized path with no budget", () => {
    expect(formatPathCompact(SAMPLE, OPTS)).toBe("minimal-agent-cli/src/ui/tool-transcript/format.ts")
    expect(formatPathCompact(SAMPLE, { ...OPTS, budget: Infinity })).toBe(
      "minimal-agent-cli/src/ui/tool-transcript/format.ts",
    )
  })

  it("picks each step at a decreasing budget", () => {
    const at = (budget: number) => formatPathCompact(SAMPLE, { ...OPTS, budget })
    expect(at(80)).toBe("minimal-agent-cli/src/ui/tool-transcript/format.ts")
    expect(at(50)).toBe("minimal-agent-cli/src/ui/tool-transcript/format.ts")
    expect(at(49)).toBe("minimal-agent-cli/s/u/tool-transcript/format.ts")
    expect(at(46)).toBe("minimal-agent-cli/\u2026/tool-transcript/format.ts")
    expect(at(30)).toBe("\u2026/tool-transcript/format.ts")
    expect(at(15)).toBe("format.ts")
    expect(at(8)).toBe("for\u2026t.ts")
  })

  it("middle-elides a long basename and keeps the extension", () => {
    const out = formatPathCompact("/x/y/very-long-name-of-a-file.test.ts", { budget: 22 })
    expect(out.endsWith(".test.ts")).toBe(true)
    expect(out).toContain("\u2026")
    expect(out.startsWith("very-")).toBe(true)
    expect(displayWidth(out)).toBeLessThanOrEqual(22)
  })

  it("measures CJK as 2 cells", () => {
    const p = "/Users/me/proj/文档/资料/报告.md"
    expect(formatPathCompact(p, { ...OPTS, budget: 100 })).toBe("文档/资料/报告.md")
    expect(formatPathCompact(p, { ...OPTS, budget: 14 })).toBe("\u2026/资料/报告.md")
    expect(formatPathCompact(p, { ...OPTS, budget: 13 })).toBe("报告.md")
    expect(formatPathCompact(p, { ...OPTS, budget: 7 })).toBe("报告.md")
    const out = formatPathCompact(p, { ...OPTS, budget: 6 })
    expect(displayWidth(out)).toBeLessThanOrEqual(6)
  })

  it("never exceeds the budget", () => {
    const paths = [
      SAMPLE,
      "/Users/me/文档/很长很长的文件名称.test.ts",
      "/etc/a-really-long-config-file-name-without-ext",
      "/Users/me/.github/workflows/ci.yml",
      "x",
    ]
    for (const p of paths) {
      for (let budget = 1; budget <= 120; budget++) {
        const out = formatPathCompact(p, { ...OPTS, budget })
        expect(displayWidth(out)).toBeLessThanOrEqual(budget)
        expect(out.length).toBeGreaterThan(0)
      }
    }
  })

  it("returns an empty string for a budget below 1", () => {
    expect(formatPathCompact(SAMPLE, { ...OPTS, budget: 0 })).toBe("")
  })
})

describe("splitPathForStyle", () => {
  it("splits dir with a trailing / and basename", () => {
    expect(splitPathForStyle("src/ui/format.ts")).toEqual({ dir: "src/ui/", base: "format.ts" })
    expect(splitPathForStyle("format.ts")).toEqual({ dir: "", base: "format.ts" })
    expect(splitPathForStyle("/a")).toEqual({ dir: "/", base: "a" })
  })
})
