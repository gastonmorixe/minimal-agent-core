/**
 * Unit tests for the emit-output inline-tag handler.
 *
 * Runs fully decoupled from the host loader — constructs TUIContext objects
 * by hand, with a fake `blobs:read` capability for the `tool=` path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { TUIContext } from "@minimal-agent/plugin-api/types/plugin"

import emitOutputHandler from "./emit_output.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake `blobs:read` API returning canned responses. */
interface FakeBlobsRead {
  readCalls: Array<{ sid: string; toolUseId: string }>
  responses: Map<string, { text: string; bytes: number; clipped: boolean } | null>
}
function makeFakeBlobs(): FakeBlobsRead & {
  read: (
    sid: string,
    id: string,
    opts: { maxBytes: number },
  ) => Promise<{ text: string; bytes: number; clipped: boolean } | null>
} {
  const fake: FakeBlobsRead = { readCalls: [], responses: new Map() }
  const read = async (sid: string, toolUseId: string, _opts: { maxBytes: number }) => {
    fake.readCalls.push({ sid, toolUseId })
    const key = `${sid}\x00${toolUseId}`
    const r = fake.responses.get(key)
    if (r === undefined) return null
    if (r === null) return null
    return { text: r.text, bytes: r.bytes, clipped: r.clipped }
  }
  return Object.assign(fake, { read })
}

function makeCtx(opts: {
  tool?: string
  path?: string
  title?: string
  cwd?: string
  blobs?: FakeBlobsRead & {
    read: (sid: string, id: string, opts: { maxBytes: number }) => Promise<unknown>
  }
  sessionId?: string
}): TUIContext {
  const attrs: Record<string, string> = {}
  if (opts.tool !== undefined) attrs.tool = opts.tool
  if (opts.path !== undefined) attrs.path = opts.path
  if (opts.title !== undefined) attrs.title = opts.title
  return {
    trigger: { type: "inline_tag", name: "output", attrs, body: "", self_closing: true },
    packageDir: "/fake/emit-output",
    cwd: opts.cwd ?? "/Users/fake/project",
    env: {},
    abort: new AbortController().signal,
    stdout: process.stdout as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as any,
    agent: opts.sessionId
      ? { sessionId: opts.sessionId, pid: 1, model: "test", version: "0.0.0" }
      : undefined,
    host: opts.blobs
      ? { capabilities: ["blobs:read" as const], blobs: { read: opts.blobs.read } as any }
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emit_output handler", () => {
  // -- validation ------------------------------------------------------------

  it("rejects when neither tool= nor path= is provided", async () => {
    const ctx = makeCtx({})
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("exactly one")
  })

  it("rejects when both tool= and path= are provided", async () => {
    const ctx = makeCtx({ tool: "x", path: "/tmp/x" })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("exactly one")
  })

  // -- tool= mode ------------------------------------------------------------

  it("returns dim marker when no session id is available for tool=", async () => {
    const ctx = makeCtx({ tool: "call_00_xyz" })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("no session id available")
  })

  it("returns dim marker when blobs:read capability is not granted", async () => {
    const ctx = makeCtx({ tool: "call_00_xyz", sessionId: "sid-1" })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("capability not granted")
  })

  it("returns dim marker when blob is not found", async () => {
    const blobs = makeFakeBlobs()
    const ctx = makeCtx({ tool: "call_00_missing", sessionId: "sid-1", blobs })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("blob not found")
  })

  it("renders blob content when found", async () => {
    const blobs = makeFakeBlobs()
    blobs.responses.set("sid-1\x00call_00_xyz", { text: "hello world", bytes: 11, clipped: false })
    const ctx = makeCtx({ tool: "call_00_xyz", sessionId: "sid-1", blobs })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    const ansi = (res as { ansi: string }).ansi
    expect(ansi).toContain("hello world")
    expect(ansi).not.toContain("blob not found")
  })

  it("adds a clipped note when blob is clipped", async () => {
    const blobs = makeFakeBlobs()
    blobs.responses.set("sid-1\x00call_00_xyz", {
      text: "small",
      bytes: 300_000,
      clipped: true,
    })
    const ctx = makeCtx({ tool: "call_00_xyz", sessionId: "sid-1", blobs })
    const res = await emitOutputHandler(ctx)
    const ansi = (res as { ansi: string }).ansi
    expect(ansi).toContain("[clipped")
    expect(ansi).toContain("bytes]")
  })

  // -- path= mode (real filesystem) ------------------------------------------

  let tmpDir: string
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "emit-output-test-"))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("renders content from a file under the project cwd", async () => {
    const fp = join(tmpDir, "project", "notes.txt")
    mkdirp(tmpDir, "project")
    writeFileSync(fp, "project content")
    const ctx = makeCtx({
      path: fp,
      cwd: join(tmpDir, "project"),
    })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("project content")
  })

  it("renders content from /tmp (symlinked to /private/tmp on macOS)", async () => {
    const fp = join("/tmp", `emit-output-test-${Date.now()}.txt`)
    writeFileSync(fp, "tmp content")
    try {
      const ctx = makeCtx({ path: fp })
      const res = await emitOutputHandler(ctx)
      expect(res.kind).toBe("rendered")
      expect((res as { ansi: string }).ansi).toContain("tmp content")
    } finally {
      rmSync(fp, { force: true })
    }
  })

  it("rejects a file outside cwd and /tmp", async () => {
    const ctx = makeCtx({ path: "/etc/hosts", cwd: "/Users/fake/project" })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("not in /tmp/ or project dir")
  })

  it("rejects a nonexistent file", async () => {
    const ctx = makeCtx({ path: "/tmp/does-not-exist-99ccb234.txt" })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("not found or not readable")
  })

  it("rejects a binary file", async () => {
    const fp = join(tmpDir, "binary.bin")
    writeFileSync(fp, Buffer.from([0x00, 0x01, 0x02, 0x03]))
    const ctx = makeCtx({ path: fp, cwd: tmpDir })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("binary file")
  })

  it("returns dim marker for empty content", async () => {
    const fp = join(tmpDir, "empty.txt")
    writeFileSync(fp, "")
    const ctx = makeCtx({ path: fp, cwd: tmpDir })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    expect((res as { ansi: string }).ansi).toContain("empty content")
  })

  it("clips content exceeding MAX_BYTES", async () => {
    const fp = join(tmpDir, "big.txt")
    // Write ~270 KiB, enough to exceed 256 KiB cap.
    const big = "x".repeat(270 * 1024)
    writeFileSync(fp, big)
    const ctx = makeCtx({ path: fp, cwd: tmpDir })
    const res = await emitOutputHandler(ctx)
    expect(res.kind).toBe("rendered")
    const ansi = (res as { ansi: string }).ansi
    expect(ansi).toContain("[clipped")
    expect(ansi).toContain("bytes]")
    // Content should be capped to 256 KiB.
    const content = ansi
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\[clipped \d+ bytes\]/, "")
      .trim()
    expect(content.length).toBeLessThanOrEqual(256 * 1024 + 10) // small margin for heading
  })

  // -- title= attribute ------------------------------------------------------

  it("renders a title heading when title= is set", async () => {
    const fp = join(tmpDir, "titled.txt")
    writeFileSync(fp, "body")
    const ctx = makeCtx({ path: fp, cwd: tmpDir, title: "My Output" })
    const res = await emitOutputHandler(ctx)
    const ansi = (res as { ansi: string }).ansi
    expect(ansi).toContain("My Output")
    expect(ansi).toContain("──")
  })

  it("omits the title heading when title= is absent", async () => {
    const fp = join(tmpDir, "notitle.txt")
    writeFileSync(fp, "body")
    const ctx = makeCtx({ path: fp, cwd: tmpDir })
    const res = await emitOutputHandler(ctx)
    const ansi = (res as { ansi: string }).ansi
    expect(ansi).not.toContain("──")
  })
})

// Tiny mkdirp helper.
function mkdirp(root: string, rel: string): void {
  mkdirSync(join(root, rel), { recursive: true })
}
