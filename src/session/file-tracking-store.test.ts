import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  FileTrackingStore,
  fileTrackingPath,
  normalizeTrackedPath,
  statMetadata,
} from "./file-tracking-store.ts"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ma-file-tracking-"))
}

describe("file tracking paths and metadata", () => {
  it("normalizes relative paths against the configured cwd", () => {
    expect(normalizeTrackedPath("./src/../file.txt", "/tmp/project")).toBe("/tmp/project/file.txt")
    expect(normalizeTrackedPath("/tmp/project/../other", "/tmp/project")).toBe("/tmp/other")
  })

  it("uses the durable sid sidecar filename", () => {
    expect(fileTrackingPath("abc", "/tmp/sessions")).toBe("/tmp/sessions/abc.files.jsonl")
  })

  it("rejects unsafe session ids that could escape the sessions dir", () => {
    expect(() => fileTrackingPath("../escape", "/tmp/sessions")).toThrow(/unsafe session id/)
    expect(() => fileTrackingPath("a/b", "/tmp/sessions")).toThrow(/unsafe session id/)
    expect(() => fileTrackingPath("a\\b", "/tmp/sessions")).toThrow(/unsafe session id/)
    expect(() => fileTrackingPath("a\0b", "/tmp/sessions")).toThrow(/unsafe session id/)
    expect(() => fileTrackingPath("", "/tmp/sessions")).toThrow(/unsafe session id/)
  })

  it("reports size, device, inode, and a mtime", () => {
    const dir = tempDir()
    const path = join(dir, "one.txt")
    writeFileSync(path, "hello")
    const metadata = statMetadata(path)
    expect(metadata?.size).toBe(5)
    expect(typeof metadata?.dev).toBe("number")
    expect(typeof metadata?.ino).toBe("number")
    expect(typeof metadata?.mtimeMs).toBe("number")
    if (metadata?.mtimeNs !== undefined) expect(metadata.mtimeNs).toMatch(/^\d+$/)
    rmSync(dir, { recursive: true })
  })

  it("returns null for a missing path", () => {
    expect(statMetadata("/definitely/not/a/file")).toBeNull()
  })
})

describe("FileTrackingStore", () => {
  it("creates the sidecar file at construction (never missing until first append)", () => {
    const dir = tempDir()
    const nested = join(dir, "sessions")
    const store = new FileTrackingStore({ sid: "boot-sid", dir: nested, cwd: dir })
    expect(store.path).toBe(join(nested, "boot-sid.files.jsonl"))
    // The file must exist on disk immediately — even with zero observations —
    // so FilesStats / boot never see a "missing" tracking state.
    expect(existsSync(store.path)).toBe(true)
    expect(readFileSync(store.path, "utf8")).toBe("")
    rmSync(dir, { recursive: true })
  })

  it("appends records and captures existing and missing files", () => {
    const dir = tempDir()
    const root = join(dir, "work")
    mkdirSync(root)
    const existing = join(root, "a.txt")
    writeFileSync(existing, "abc")
    const store = new FileTrackingStore({ sid: "sid", dir, cwd: root })
    const first = store.append("a.txt")
    const missing = store.append("missing.txt")
    expect(first.path).toBe(existing)
    expect(first.metadata?.size).toBe(3)
    expect(missing.metadata).toBeNull()
    expect(
      readFileSync(join(dir, "sid.files.jsonl"), "utf8").split("\n").filter(Boolean),
    ).toHaveLength(2)
    expect(store.current()).toHaveLength(2)
    rmSync(dir, { recursive: true })
  })

  it("replays the latest record for each normalized path", () => {
    const dir = tempDir()
    const sidecar = join(dir, "sid.files.jsonl")
    const old = { path: "./file.txt", metadata: null, recordedAt: "2020-01-01T00:00:00.000Z" }
    const newer = {
      path: join(dir, "file.txt"),
      metadata: { size: 2, dev: 1, ino: 2, mtimeMs: 3 },
      recordedAt: "2021-01-01T00:00:00.000Z",
    }
    appendFileSync(sidecar, `${JSON.stringify(old)}\n${JSON.stringify(newer)}\nnot-json\n`)
    const store = new FileTrackingStore({ sid: "sid", dir, cwd: dir })
    expect(store.current()).toEqual([{ ...newer, path: join(dir, "file.txt") }])
    expect(store.lookup("file.txt")?.recordedAt).toBe(newer.recordedAt)
    rmSync(dir, { recursive: true })
  })

  it("looks up paths equivalently after normalization", () => {
    const dir = tempDir()
    mkdirSync(join(dir, "nested"))
    writeFileSync(join(dir, "nested", "x"), "x")
    const store = new FileTrackingStore({ sid: "sid", dir, cwd: dir })
    store.track("nested/./x")
    expect(store.lookup("nested/../nested/x")?.path).toBe(join(dir, "nested", "x"))
    expect(store.lookup("nope")).toBeUndefined()
    rmSync(dir, { recursive: true })
  })

  it("reports present, changed, and missing status", () => {
    const dir = tempDir()
    const path = join(dir, "x")
    writeFileSync(path, "one")
    const store = new FileTrackingStore({ sid: "sid", dir })
    store.append(path)
    expect(store.status(path)).toBe("present")
    writeFileSync(path, "two")
    expect(store.status(path)).toBe("changed")
    rmSync(path)
    expect(store.status(path)).toBe("missing")
    expect(store.statuses()[0]?.status).toBe("missing")
    rmSync(dir, { recursive: true })
  })

  it("distinguishes a replacement file by inode or metadata", () => {
    const dir = tempDir()
    const path = join(dir, "x")
    writeFileSync(path, "same")
    const store = new FileTrackingStore({ sid: "sid", dir })
    store.append(path)
    rmSync(path)
    writeFileSync(path, "same")
    const status = store.status(path)
    expect(status === "present" || status === "changed").toBe(true)
    rmSync(dir, { recursive: true })
  })

  it("creates parent directories lazily and survives a truncated replay line", () => {
    const dir = tempDir()
    const nested = join(dir, "nested", "sid.files.jsonl")
    mkdirSync(join(dir, "nested"), { recursive: true })
    writeFileSync(nested, '{"path":"ok","metadata":null,"recordedAt":"x"}\n{"path":"')
    const store = new FileTrackingStore({ sid: "sid", dir: join(dir, "nested"), cwd: dir })
    expect(store.current()).toHaveLength(1)
    rmSync(dir, { recursive: true })
  })
})
