/**
 * Tests for {@link refreshAndRender} and its helpers.
 *
 * Strategy: write fake memory.md to a temp dir, point the refresh at
 * it, inject a `summarize` fake to control the LLM behavior, assert
 * the final injection text + side effects on summary.md.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { DEFAULT_MEMORY_CONFIG, type MemorySummaryParams } from "./memory-config.ts"
import { SummarizeError } from "./summarize.ts"
import {
  headlineOf,
  parseCutoff,
  partitionByCutoff,
  refreshAndRender,
  renderPendingSection,
  stripCutoffHeader,
  summaryPathFor,
  withCutoffHeader,
} from "./summary-refresh.ts"

const tempDirs: string[] = []
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "summary-refresh-test-"))
  tempDirs.push(d)
  return d
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkBullet(id: string, ts: string | null, body: string): string {
  if (ts === null) return `- ${body}`
  return `- [#${id}] [${ts}] ${body}`
}

/**
 * Format a Date as `YYYY-MM-DDTHH:MM:SS+00:00`: UTC offset, no
 * milliseconds: to match `parse.ts:TS_RE`. Without this, `parseFile`
 * treats the timestamp prefix as legacy non-timestamped text.
 */
function formatTsNoMs(d: Date): string {
  return `${d.toISOString().slice(0, 19)}+00:00`
}

function manyBullets(n: number, tsBase = "2026-05-01T00:00:00-04:00"): string {
  const baseMs = Date.parse(tsBase)
  return Array.from({ length: n }, (_, i) => {
    const ts = formatTsNoMs(new Date(baseMs + i * 1000))
    // Pad each body so the file easily clears any sane minBytes threshold.
    const body = `body for bullet ${i}: `.padEnd(120, "x")
    return mkBullet(`b${i}`, ts, body)
  }).join("\n")
}

// Test config tuned so tests are fast: drop the thresholds so even
// small fixtures trigger the LLM path. (The "enabled" gate moved
// upstream to handlers/load.ts via inject-mode strategy; refreshAndRender
// is only ever called when summary mode is selected.)
const ENABLED_CFG: MemorySummaryParams = {
  ...DEFAULT_MEMORY_CONFIG.summary,
  minBullets: 5,
  minBytes: 100,
  dirtyBullets: 2,
}

// ---------------------------------------------------------------------------
// Unit tests: cutoff header
// ---------------------------------------------------------------------------

describe("parseCutoff", () => {
  it("parses a valid header", () => {
    const ts = parseCutoff("<!-- regen-cutoff: 2026-05-14T03:45:00.123-04:00 -->\n\n## stuff")
    expect(ts).toBe("2026-05-14T03:45:00.123-04:00")
  })

  it("returns null when no header", () => {
    expect(parseCutoff("just some markdown")).toBeNull()
    expect(parseCutoff("")).toBeNull()
  })

  it("returns null when ISO is malformed", () => {
    expect(parseCutoff("<!-- regen-cutoff: not-a-date -->\n")).toBeNull()
    expect(parseCutoff("<!-- regen-cutoff: 2026-13-99 -->\n")).toBeNull()
  })

  it("tolerates flexible whitespace inside the comment", () => {
    const ts = parseCutoff("<!--   regen-cutoff:   2026-05-14T00:00:00Z   -->")
    expect(ts).toBe("2026-05-14T00:00:00Z")
  })
})

describe("stripCutoffHeader / withCutoffHeader round-trip", () => {
  it("strips a header cleanly", () => {
    const input = "<!-- regen-cutoff: 2026-05-14T00:00:00Z -->\n\n## stuff\nbody"
    expect(stripCutoffHeader(input)).toBe("## stuff\nbody")
  })

  it("is a no-op for content without a header", () => {
    expect(stripCutoffHeader("## stuff\nbody")).toBe("## stuff\nbody")
  })

  it("withCutoffHeader -> stripCutoffHeader is identity (modulo trailing newline)", () => {
    const body = "## Cluster A\n- takeaway. Sources: #a, #b"
    const wrapped = withCutoffHeader(body, "2026-05-14T00:00:00Z")
    const parsed = parseCutoff(wrapped)
    expect(parsed).toBe("2026-05-14T00:00:00Z")
    expect(stripCutoffHeader(wrapped).trim()).toBe(body)
  })
})

// ---------------------------------------------------------------------------
// Unit tests: partitionByCutoff
// ---------------------------------------------------------------------------

describe("partitionByCutoff", () => {
  it("splits bullets at the cutoff timestamp", () => {
    const file = [
      mkBullet("old1", "2026-05-01T00:00:00-04:00", "old body 1"),
      mkBullet("old2", "2026-05-05T00:00:00-04:00", "old body 2"),
      mkBullet("new1", "2026-05-13T00:00:00-04:00", "new body 1"),
      mkBullet("new2", "2026-05-14T00:00:00-04:00", "new body 2"),
    ].join("\n")
    const { parseFile } = require("./parse.ts") as typeof import("./parse.ts")
    const bullets = parseFile(file)
    const { inSummary, pending } = partitionByCutoff(bullets, "2026-05-10T00:00:00-04:00")
    expect(inSummary.map((b) => b.id)).toEqual(["old1", "old2"])
    expect(pending.map((b) => b.id)).toEqual(["new1", "new2"])
  })

  it("puts legacy bullets (ts=null) into pending", () => {
    const file = [
      mkBullet("ok", "2026-05-01T00:00:00-04:00", "old body"),
      mkBullet("legacy", null, "legacy line with no ts prefix"),
    ].join("\n")
    const { parseFile } = require("./parse.ts") as typeof import("./parse.ts")
    const bullets = parseFile(file)
    const { inSummary, pending } = partitionByCutoff(bullets, "2026-05-10T00:00:00-04:00")
    expect(inSummary.map((b) => b.id)).toEqual(["ok"])
    expect(pending.length).toBe(1)
    expect(pending[0].isLegacy).toBe(true)
  })

  it("returns everything as pending for a bogus cutoff", () => {
    const file = mkBullet("a", "2026-05-01T00:00:00-04:00", "body")
    const { parseFile } = require("./parse.ts") as typeof import("./parse.ts")
    const bullets = parseFile(file)
    const { inSummary, pending } = partitionByCutoff(bullets, "not-a-date")
    expect(inSummary.length).toBe(0)
    expect(pending.length).toBe(1)
  })

  it("handles empty bullet list", () => {
    const { inSummary, pending } = partitionByCutoff([], "2026-05-10T00:00:00-04:00")
    expect(inSummary).toEqual([])
    expect(pending).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Unit tests: headlines & pending rendering
// ---------------------------------------------------------------------------

describe("headlineOf", () => {
  it("returns short bodies as-is", () => {
    expect(headlineOf("short body")).toBe("short body")
  })

  it("returns the first sentence when present", () => {
    const body =
      "The compositor caps blank lines at 3. Otherwise the agent's status row drifts up. Tests at src/ui/compositor.test.ts."
    const out = headlineOf(body)
    expect(out).toBe("The compositor caps blank lines at 3.")
  })

  it("hard-truncates with ellipsis when no sentence boundary in range", () => {
    const body = "x".repeat(200)
    const out = headlineOf(body, 100)
    expect(out.length).toBeLessThanOrEqual(101)
    expect(out.endsWith("…")).toBe(true)
  })

  it("backs off to a word boundary if one exists in the second half", () => {
    const body = "word word word word word word word word word word word word word word"
    const out = headlineOf(body, 30)
    // No trailing space before the ellipsis.
    expect(out.endsWith(" …")).toBe(false)
    expect(out.endsWith("…")).toBe(true)
    // Output should not exceed maxChars + 1 (for the ellipsis).
    expect(out.length).toBeLessThanOrEqual(31)
    // Should end on a full word, not mid-word.
    expect(out).toMatch(/word…$/)
  })
})

describe("renderPendingSection", () => {
  it("returns empty string when pending is empty", () => {
    expect(renderPendingSection([])).toBe("")
  })

  it("renders a markdown section with #id · headline lines", () => {
    const pending = [
      {
        id: "abc1",
        ts: "2026-05-14T00:00:00Z",
        sid: null,
        body: "First takeaway about the compositor.",
        isLegacy: false,
        raw: "",
      },
      {
        id: "abc2",
        ts: "2026-05-14T00:01:00Z",
        sid: null,
        body: "Second one about auth.",
        isLegacy: false,
        raw: "",
      },
    ]
    const out = renderPendingSection(pending)
    expect(out).toContain("### Recent saves (not yet in summary)")
    expect(out).toContain("- #abc1 · First takeaway about the compositor.")
    expect(out).toContain("- #abc2 · Second one about auth.")
  })
})

// ---------------------------------------------------------------------------
// Unit tests: summaryPathFor
// ---------------------------------------------------------------------------

describe("summaryPathFor", () => {
  it("appends '.summary' before the .md extension", () => {
    expect(summaryPathFor("/home/x/.minimal-agent/memory.md")).toBe(
      "/home/x/.minimal-agent/memory.summary.md",
    )
    expect(summaryPathFor("/home/x/.minimal-agent/projects/Users/foo/proj/memory.md")).toBe(
      "/home/x/.minimal-agent/projects/Users/foo/proj/memory.summary.md",
    )
  })
})

// ---------------------------------------------------------------------------
// Integration tests: refreshAndRender
// ---------------------------------------------------------------------------

function makeFakeSummarize(out: string) {
  const calls: { input: string }[] = []
  const fn = async (input: string, _opts: unknown, _deps?: unknown) => {
    calls.push({ input })
    return out
  }
  return { fn, calls }
}

describe("refreshAndRender: short-circuits", () => {
  it("returns empty text when memory file is absent", async () => {
    const dir = makeTempDir()
    const r = await refreshAndRender({
      scope: "project",
      memoryPath: join(dir, "memory.md"),
      summaryPath: join(dir, "memory.summary.md"),
      cfg: ENABLED_CFG,
    })
    expect(r.text).toBe("")
    expect(r.regenerated).toBe(false)
    expect(r.reason).toBe("no-memory-file")
  })

  it("returns empty text when memory file is empty", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "memory.md"), "")
    const r = await refreshAndRender({
      scope: "project",
      memoryPath: join(dir, "memory.md"),
      summaryPath: join(dir, "memory.summary.md"),
      cfg: ENABLED_CFG,
    })
    expect(r.text).toBe("")
    expect(r.reason).toBe("empty-memory")
  })

  // NOTE: an earlier "returns verbatim when summary is disabled" case
  // lived here. The `enabled` knob moved upstream to handlers/load.ts
  // (via inject-mode strategy), so refreshAndRender no longer has an
  // internal disabled-state: its caller decides whether to invoke it
  // at all. The load.ts tests cover the new behavior.

  it("returns verbatim when below minBullets threshold", async () => {
    const dir = makeTempDir()
    const memContent = manyBullets(3) // < ENABLED_CFG.minBullets = 5
    writeFileSync(join(dir, "memory.md"), memContent)
    const fake = makeFakeSummarize("does not run")
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: ENABLED_CFG,
      },
      { summarize: fake.fn },
    )
    expect(r.regenerated).toBe(false)
    expect(r.reason).toContain("below-threshold")
    expect(fake.calls.length).toBe(0)
  })

  it("returns verbatim when below minBytes threshold", async () => {
    const dir = makeTempDir()
    // 6 bullets: clears minBullets=5, but content is ~720 bytes: under
    // a high minBytes setting.
    const memContent = manyBullets(6)
    writeFileSync(join(dir, "memory.md"), memContent)
    const fake = makeFakeSummarize("does not run")
    const cfgWithHighMinBytes: MemorySummaryParams = { ...ENABLED_CFG, minBytes: 100_000 }
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: cfgWithHighMinBytes,
      },
      { summarize: fake.fn },
    )
    expect(r.regenerated).toBe(false)
    expect(r.reason).toContain("below-threshold")
    expect(fake.calls.length).toBe(0)
  })
})

describe("refreshAndRender: regen triggers", () => {
  it("regens when no summary.md exists", async () => {
    const dir = makeTempDir()
    const memContent = manyBullets(20)
    writeFileSync(join(dir, "memory.md"), memContent)
    const summary =
      "## Cluster A\n- takeaway one. Sources: #b0, #b1\n## Cluster B\n- takeaway two. Sources: #b2, #b3, #b4\n"
    const fake = makeFakeSummarize(summary)
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: ENABLED_CFG,
      },
      { summarize: fake.fn, now: () => new Date("2026-05-14T03:00:00Z") },
    )
    expect(r.regenerated).toBe(true)
    expect(r.reason).toContain("no-summary")
    expect(fake.calls.length).toBe(1)
    expect(fake.calls[0].input).toBe(memContent)
    // summary.md was written with the cutoff header.
    const written = readFileSync(join(dir, "memory.summary.md"), "utf-8")
    expect(written).toContain("<!-- regen-cutoff: 2026-05-14T03:00:00.000Z -->")
    expect(written).toContain("## Cluster A")
    // Returned text has cutoff stripped.
    expect(r.text).not.toContain("regen-cutoff")
    expect(r.text).toContain("## Cluster A")
  })

  it("regens when summary lacks a cutoff header (legacy/corrupt)", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "memory.md"), manyBullets(20))
    writeFileSync(join(dir, "memory.summary.md"), "## Old summary\n- something\n")
    const summary =
      "## Cluster A\n- takeaway one. Sources: #b0, #b1\n## Cluster B\n- takeaway two. Sources: #b2, #b3, #b4\n"
    const fake = makeFakeSummarize(summary)
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: ENABLED_CFG,
      },
      { summarize: fake.fn },
    )
    expect(r.regenerated).toBe(true)
    expect(r.reason).toContain("no-cutoff-in-summary")
    expect(fake.calls.length).toBe(1)
  })

  it("regens when dirty bullets >= threshold", async () => {
    const dir = makeTempDir()
    // 20 bullets total; first 15 dated before cutoff, last 5 after.
    const old = manyBullets(15, "2026-05-01T00:00:00-04:00")
    const newPart = manyBullets(5, "2026-05-13T00:00:00-04:00").replace(
      /#b(\d+)/g,
      (_m, n) => `#n${n}`,
    )
    writeFileSync(join(dir, "memory.md"), `${old}\n${newPart}`)
    const oldSummary = withCutoffHeader(
      "## Old cluster\n- old takeaway. Sources: #b0",
      "2026-05-05T00:00:00-04:00",
    )
    writeFileSync(join(dir, "memory.summary.md"), oldSummary)

    const fake = makeFakeSummarize("## Fresh\n- new takeaway. Sources: #n0, #n1, #n2, #n3, #n4\n")
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: { ...ENABLED_CFG, dirtyBullets: 3 }, // 5 dirty >= 3 → regen
      },
      { summarize: fake.fn, now: () => new Date("2026-05-14T03:00:00Z") },
    )
    expect(r.regenerated).toBe(true)
    expect(r.reason).toContain("regenerated")
    expect(fake.calls.length).toBe(1)
    expect(r.text).toContain("## Fresh")
    expect(r.text).not.toContain("### Recent saves") // post-regen, no pending
  })
})

describe("refreshAndRender: fresh-enough path (no regen)", () => {
  it("returns existing summary with empty pending when nothing is dirty", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "memory.md"), manyBullets(10, "2026-05-01T00:00:00-04:00"))
    const oldSummary = withCutoffHeader(
      "## Cluster A\n- takeaway. Sources: #b0",
      "2026-05-10T00:00:00-04:00",
    )
    writeFileSync(join(dir, "memory.summary.md"), oldSummary)
    const fake = makeFakeSummarize("does not run")
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: ENABLED_CFG,
      },
      { summarize: fake.fn },
    )
    expect(r.regenerated).toBe(false)
    expect(r.reason).toContain("fresh")
    expect(fake.calls.length).toBe(0)
    expect(r.text).toContain("## Cluster A")
    expect(r.text).not.toContain("### Recent saves")
  })

  it("returns summary + pending headlines when dirty < threshold", async () => {
    const dir = makeTempDir()
    // 10 old + 1 new, threshold is 2 → no regen, but pending has 1.
    const old = manyBullets(10, "2026-05-01T00:00:00-04:00")
    const newOne = mkBullet("recent1", "2026-05-13T00:00:00-04:00", "freshly saved bullet body")
    writeFileSync(join(dir, "memory.md"), `${old}\n${newOne}`)
    const oldSummary = withCutoffHeader(
      "## Cluster A\n- takeaway. Sources: #b0",
      "2026-05-10T00:00:00-04:00",
    )
    writeFileSync(join(dir, "memory.summary.md"), oldSummary)
    const fake = makeFakeSummarize("does not run")
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: { ...ENABLED_CFG, dirtyBullets: 5 }, // 1 dirty < 5 → no regen
      },
      { summarize: fake.fn },
    )
    expect(r.regenerated).toBe(false)
    expect(r.reason).toContain("fresh")
    expect(fake.calls.length).toBe(0)
    expect(r.text).toContain("## Cluster A")
    expect(r.text).toContain("### Recent saves (not yet in summary)")
    expect(r.text).toContain("- #recent1 · freshly saved bullet body")
  })
})

describe("refreshAndRender: failure modes", () => {
  it("falls back to last-good summary on summarize error", async () => {
    const dir = makeTempDir()
    // 20 bullets dated AFTER the old-summary cutoff → forces regen attempt.
    writeFileSync(join(dir, "memory.md"), manyBullets(20, "2026-05-12T00:00:00-04:00"))
    const oldSummary = withCutoffHeader(
      "## Last-good\n- old takeaway. Sources: #b0",
      "2026-05-05T00:00:00-04:00",
    )
    writeFileSync(join(dir, "memory.summary.md"), oldSummary)
    const failingSummarize = async () => {
      throw new SummarizeError("send-failed", "network down")
    }
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: { ...ENABLED_CFG, dirtyBullets: 1 }, // force regen attempt
      },
      { summarize: failingSummarize },
    )
    expect(r.regenerated).toBe(false)
    expect(r.reason).toContain("regen-failed-fallback")
    expect(r.text).toContain("## Last-good")
    // summary.md untouched.
    const onDisk = readFileSync(join(dir, "memory.summary.md"), "utf-8")
    expect(onDisk).toBe(oldSummary)
  })

  it("falls back to verbatim memory when regen fails AND no last-good", async () => {
    const dir = makeTempDir()
    const memContent = manyBullets(20)
    writeFileSync(join(dir, "memory.md"), memContent)
    const failingSummarize = async () => {
      throw new SummarizeError("auth-failed", "no creds")
    }
    const r = await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: ENABLED_CFG,
      },
      { summarize: failingSummarize },
    )
    expect(r.regenerated).toBe(false)
    expect(r.reason).toContain("regen-failed-no-fallback")
    expect(r.text).toBe(memContent.trim())
    expect(existsSync(join(dir, "memory.summary.md"))).toBe(false)
  })
})

describe("refreshAndRender: atomic write", () => {
  it("writes summary.md in one step (no torn write on early exit)", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "memory.md"), manyBullets(20))
    const summary = "## A\n- t. Sources: #b0, #b1, #b2, #b3, #b4, #b5\n"
    const fake = makeFakeSummarize(summary)
    await refreshAndRender(
      {
        scope: "project",
        memoryPath: join(dir, "memory.md"),
        summaryPath: join(dir, "memory.summary.md"),
        cfg: ENABLED_CFG,
      },
      { summarize: fake.fn },
    )
    // No lingering .tmp.<pid> file should remain in the dir.
    const { readdirSync } = require("node:fs") as typeof import("node:fs")
    const files = readdirSync(dir)
    expect(files.some((f) => f.includes(".tmp."))).toBe(false)
  })
})
