/**
 * `<sid>.files/**` (the `sessions:files` capability) in the session store:
 * the fork helper (EXDEV copy, symlink skip) and the cleanup scope. The
 * main fork and cleanup cases are in `session-store.test.ts`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { linkSessionFilesTree } from "./session-files-tree.ts"
import { SessionStore } from "./session-store.ts"

const baseOpenOpts = {
  model: "test-model-1",
  cwd: "/tmp/example",
  systemHash: "deadbeef",
  toolsHash: "cafebabe",
  agentVersion: "test",
}

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ma-session-files-tree-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("linkSessionFilesTree", () => {
  it("copies on EXDEV (a link across devices)", () => {
    const dir = tmp()
    const src = join(dir, "src.files")
    const dst = join(dir, "dst.files")
    mkdirSync(join(src, "demo"), { recursive: true })
    writeFileSync(join(src, "demo", "a.txt"), "alpha")
    const exdev = () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" })
    }
    linkSessionFilesTree(src, dst, exdev)
    const from = join(src, "demo", "a.txt")
    const to = join(dst, "demo", "a.txt")
    expect(readFileSync(to, "utf-8")).toBe("alpha")
    // A copy: a new inode.
    expect(statSync(to).ino).not.toBe(statSync(from).ino)
  })

  it("skips a file on another link error (no copy)", () => {
    const dir = tmp()
    const src = join(dir, "src.files")
    mkdirSync(join(src, "demo"), { recursive: true })
    writeFileSync(join(src, "demo", "a.txt"), "alpha")
    linkSessionFilesTree(src, join(dir, "dst.files"), () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" })
    })
    expect(existsSync(join(dir, "dst.files", "demo", "a.txt"))).toBe(false)
  })

  it.skipIf(process.platform === "win32")("skips a symlink on purpose", () => {
    const dir = tmp()
    const src = join(dir, "src.files")
    const outside = join(dir, "outside.txt")
    writeFileSync(outside, "secret")
    mkdirSync(join(src, "demo"), { recursive: true })
    symlinkSync(outside, join(src, "demo", "link.txt"))
    writeFileSync(join(src, "demo", "a.txt"), "alpha")
    linkSessionFilesTree(src, join(dir, "dst.files"))
    expect(readdirSync(join(dir, "dst.files", "demo"))).toEqual(["a.txt"])
  })
})

describe("SessionStore.cleanupIfUnused and <sid>.files/", () => {
  it("removes only its own <sid>.files/: a sibling sid keeps its files", () => {
    const dir = tmp()
    const sid = "ma-unused-F"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    // Siblings: another sid, and a sid that starts with the same text.
    const siblings = ["ma-unused-G", `${sid}x`]
    for (const other of siblings) {
      mkdirSync(join(dir, `${other}.files`, "demo"), { recursive: true })
      writeFileSync(join(dir, `${other}.files`, "demo", "a.txt"), other)
    }
    mkdirSync(join(dir, `${sid}.files`, "demo"), { recursive: true })
    writeFileSync(join(dir, `${sid}.files`, "demo", "a.txt"), "mine")

    expect(store.cleanupIfUnused()).toBe(true)
    expect(existsSync(join(dir, `${sid}.files`))).toBe(false)
    for (const other of siblings) {
      expect(readFileSync(join(dir, `${other}.files`, "demo", "a.txt"), "utf-8")).toBe(other)
    }
  })
})
