/**
 * `sessions:files` provider (paste plugin v3, B2). All writes go to a temp
 * sessions dir.
 */

import {
  existsSync,
  lstatSync,
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

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { SessionStore } from "../../../session/session-store.ts"

import { displayReadSid, withDisplayReadSid } from "./owned-session.ts"
import {
  createSessionFilesApi,
  DEFAULT_SESSION_FILE_MAX_BYTES,
  DEFAULT_SESSION_FILES_MAX_PLUGIN_BYTES,
  isSafeSessionFileName,
} from "./session-files.ts"

const SID = "ba0ad20f-1111-4111-8111-111111111111"
const isWin = process.platform === "win32"

let dir = ""
/** Make the session file of `sid`: the sid rule needs `<sid>.jsonl`. */
const touchSession = (sid: string) => writeFileSync(join(dir, `${sid}.jsonl`), "")
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-session-files-"))
  touchSession(SID)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const api = (caps?: { maxFileBytes?: number; maxPluginBytes?: number }) =>
  createSessionFilesApi({ sessionsDir: dir, pluginId: "demo", ...(caps ? { caps } : {}) })
const root = () => join(dir, `${SID}.files`)
const pluginDir = () => join(root(), "demo")

describe("createSessionFilesApi", () => {
  it("has the default caps of the plan (32 MB, 256 MB)", () => {
    expect(DEFAULT_SESSION_FILE_MAX_BYTES).toBe(32 * 1024 * 1024)
    expect(DEFAULT_SESSION_FILES_MAX_PLUGIN_BYTES).toBe(256 * 1024 * 1024)
  })

  it("makes no dir until the first create (lazy)", () => {
    const files = api()
    expect(files.read(SID, "a.txt")).toBeNull()
    expect(files.stat(SID, "a.txt")).toBeNull()
    expect(files.usage(SID)).toEqual({ files: 0, bytes: 0 })
    expect(existsSync(root())).toBe(false)
    expect(files.create(SID, "a.txt", "hi")).toBe("ok")
    expect(existsSync(pluginDir())).toBe(true)
  })

  it("creates, reads and stats a UTF-8 file; leaves no tmp file", () => {
    const files = api()
    const text = "héllo\nwörld"
    expect(files.create(SID, "a.txt", text)).toBe("ok")
    expect(files.read(SID, "a.txt")).toBe(text)
    expect(files.stat(SID, "a.txt")).toEqual({ bytes: Buffer.byteLength(text, "utf8") })
    expect(files.usage(SID)).toEqual({ files: 1, bytes: Buffer.byteLength(text, "utf8") })
    expect(readdirSync(pluginDir())).toEqual(["a.txt"])
  })

  it.skipIf(isWin)("dirs are 0700 and files are 0600", () => {
    const files = api()
    expect(files.create(SID, "a.txt", "x")).toBe("ok")
    expect(statSync(root()).mode & 0o777).toBe(0o700)
    expect(statSync(pluginDir()).mode & 0o777).toBe(0o700)
    expect(statSync(join(pluginDir(), "a.txt")).mode & 0o777).toBe(0o600)
  })

  it("never overwrites: a second create gives exists and keeps the first text", () => {
    const files = api()
    expect(files.create(SID, "a.txt", "first")).toBe("ok")
    expect(files.create(SID, "a.txt", "second")).toBe("exists")
    expect(files.read(SID, "a.txt")).toBe("first")
    expect(readdirSync(pluginDir())).toEqual(["a.txt"])
  })

  it("EEXIST from a second instance on the same dir gives exists", () => {
    const a = api()
    const b = api()
    expect(a.create(SID, "a.txt", "one")).toBe("ok")
    expect(b.create(SID, "a.txt", "two")).toBe("exists")
    expect(b.read(SID, "a.txt")).toBe("one")
  })

  it("rejects a bad name", () => {
    const files = api()
    for (const name of [
      "",
      "A.txt",
      ".hidden",
      "-x",
      "a/b",
      "a..b",
      "../x",
      "a b",
      "x".repeat(65),
      "a\0b",
      "a.txt\0",
    ]) {
      expect(isSafeSessionFileName(name)).toBe(false)
      expect(files.create(SID, name, "x")).toBe("error")
      expect(files.read(SID, name)).toBeNull()
      expect(files.stat(SID, name)).toBeNull()
    }
    expect(isSafeSessionFileName("x".repeat(64))).toBe(true)
    expect(existsSync(root())).toBe(false)
  })

  it("rejects a bad sid", () => {
    const files = api()
    for (const sid of ["", "../evil", "a/b", "a\\b", "x".repeat(129), "a\0b"]) {
      expect(files.create(sid, "a.txt", "x")).toBe("error")
      expect(files.read(sid, "a.txt")).toBeNull()
      expect(files.stat(sid, "a.txt")).toBeNull()
      expect(files.usage(sid)).toEqual({ files: 0, bytes: 0 })
    }
    expect(readdirSync(dir)).toEqual([`${SID}.jsonl`])
  })

  it("throws on a bad plugin id (a host error)", () => {
    for (const pluginId of ["", "../x", "A", "a/b", "a..b", ".x"]) {
      expect(() => createSessionFilesApi({ sessionsDir: dir, pluginId })).toThrow(/plugin id/)
    }
  })

  it("keeps the files of two plugins apart", () => {
    const a = createSessionFilesApi({ sessionsDir: dir, pluginId: "one" })
    const b = createSessionFilesApi({ sessionsDir: dir, pluginId: "two" })
    expect(a.create(SID, "a.txt", "from one")).toBe("ok")
    expect(b.read(SID, "a.txt")).toBeNull()
    expect(b.create(SID, "a.txt", "from two")).toBe("ok")
    expect(a.read(SID, "a.txt")).toBe("from one")
    expect(b.usage(SID).files).toBe(1)
  })

  it("gives over-cap for a file over the per-file cap, and writes nothing", () => {
    const files = api({ maxFileBytes: 4 })
    expect(files.create(SID, "a.txt", "1234")).toBe("ok")
    // 5 UTF-8 bytes (the cap counts bytes, not chars).
    expect(files.create(SID, "b.txt", "12é4")).toBe("over-cap")
    expect(files.stat(SID, "b.txt")).toBeNull()
  })

  it("reads the per-plugin cap from the disk: two instances share it", () => {
    const caps = { maxPluginBytes: 10 }
    const a = api(caps)
    const b = api(caps)
    expect(a.create(SID, "a.txt", "123456")).toBe("ok")
    // b keeps no counter: it sees the 6 bytes of a on the disk.
    expect(b.usage(SID)).toEqual({ files: 1, bytes: 6 })
    expect(b.create(SID, "b.txt", "12345")).toBe("over-cap")
    expect(b.create(SID, "b.txt", "1234")).toBe("ok")
    expect(a.create(SID, "c.txt", "1")).toBe("over-cap")
    expect(a.usage(SID)).toEqual({ files: 2, bytes: 10 })
  })

  it("the per-plugin cap is per sid", () => {
    const files = api({ maxPluginBytes: 4 })
    const other = "d17b0257-2222-4222-8222-222222222222"
    touchSession(other)
    expect(files.create(SID, "a.txt", "1234")).toBe("ok")
    expect(files.create(other, "a.txt", "1234")).toBe("ok")
  })

  it("an empty file is ok", () => {
    const files = api()
    expect(files.create(SID, "empty", "")).toBe("ok")
    expect(files.read(SID, "empty")).toBe("")
    expect(files.stat(SID, "empty")).toEqual({ bytes: 0 })
  })

  it("a sid with no session file: create gives error and makes no dir", () => {
    const files = api()
    const ghost = "f730cc8c-3333-4333-8333-333333333333"
    expect(files.create(ghost, "a.txt", "x")).toBe("error")
    expect(files.read(ghost, "a.txt")).toBeNull()
    expect(files.stat(ghost, "a.txt")).toBeNull()
    expect(files.usage(ghost)).toEqual({ files: 0, bytes: 0 })
    expect(existsSync(join(dir, `${ghost}.files`))).toBe(false)
  })

  it("a sid with no session file: no read of a dir made by hand", () => {
    const ghost = "f730cc8c-3333-4333-8333-333333333333"
    mkdirSync(join(dir, `${ghost}.files`, "demo"), { recursive: true })
    writeFileSync(join(dir, `${ghost}.files`, "demo", "a.txt"), "orphan")
    const files = api()
    expect(files.read(ghost, "a.txt")).toBeNull()
    expect(files.stat(ghost, "a.txt")).toBeNull()
    expect(files.usage(ghost)).toEqual({ files: 0, bytes: 0 })
  })

  describe("with isOwnedSession (the core host)", () => {
    const owned = (sids: string[]) =>
      createSessionFilesApi({
        sessionsDir: dir,
        pluginId: "demo",
        isOwnedSession: (sid) => sids.includes(sid),
      })

    it("an owned sid with a session file works", () => {
      const files = owned([SID])
      expect(files.create(SID, "a.txt", "x")).toBe("ok")
      expect(files.read(SID, "a.txt")).toBe("x")
      expect(files.stat(SID, "a.txt")).toEqual({ bytes: 1 })
      expect(files.usage(SID)).toEqual({ files: 1, bytes: 1 })
    })

    it("a not-owned sid: error, null, zeros, and no dir", () => {
      // The session file exists, so only ownership rejects the sid.
      api().create(SID, "a.txt", "by the public api")
      const files = owned(["someone-else"])
      expect(files.create(SID, "b.txt", "x")).toBe("error")
      expect(files.read(SID, "a.txt")).toBeNull()
      expect(files.stat(SID, "a.txt")).toBeNull()
      expect(files.usage(SID)).toEqual({ files: 0, bytes: 0 })
      expect(existsSync(join(pluginDir(), "b.txt"))).toBe(false)
    })

    it("an owned sid with no session file gives error and makes no dir", () => {
      const ghost = "f730cc8c-3333-4333-8333-333333333333"
      const files = owned([ghost])
      expect(files.create(ghost, "a.txt", "x")).toBe("error")
      expect(existsSync(join(dir, `${ghost}.files`))).toBe(false)
    })

    it("a throwing isOwnedSession is not owned (no throw)", () => {
      const files = createSessionFilesApi({
        sessionsDir: dir,
        pluginId: "demo",
        isOwnedSession: () => {
          throw new Error("boom")
        },
      })
      expect(files.create(SID, "a.txt", "x")).toBe("error")
      expect(files.read(SID, "a.txt")).toBeNull()
    })
  })

  describe("display scope (withDisplayReadSid)", () => {
    const OLD = "0a1d0001-4444-4444-8444-444444444444"
    const owned = () =>
      createSessionFilesApi({ sessionsDir: dir, pluginId: "demo", isOwnedSession: () => false })
    const seedOld = () => {
      touchSession(OLD)
      mkdirSync(join(dir, `${OLD}.files`, "demo"), { recursive: true })
      writeFileSync(join(dir, `${OLD}.files`, "demo", "a.txt"), "old text")
    }

    it("display scope: read of an old existing sid", () => {
      seedOld()
      const files = owned()
      expect(files.read(OLD, "a.txt")).toBeNull()
      withDisplayReadSid(OLD, () => {
        expect(files.read(OLD, "a.txt")).toBe("old text")
        expect(files.readHead?.(OLD, "a.txt", 3)).toEqual({
          text: "old",
          bytes: 8,
          truncated: true,
        })
        expect(files.stat(OLD, "a.txt")).toEqual({ bytes: 8 })
        expect(files.usage(OLD)).toEqual({ files: 1, bytes: 8 })
      })
    })

    it("display scope: create of that sid is still error", () => {
      seedOld()
      const files = owned()
      withDisplayReadSid(OLD, () => {
        expect(files.create(OLD, "b.txt", "x")).toBe("error")
      })
      expect(existsSync(join(dir, `${OLD}.files`, "demo", "b.txt"))).toBe(false)
    })

    it("display scope ends after the call", () => {
      seedOld()
      const files = owned()
      expect(withDisplayReadSid(OLD, () => displayReadSid())).toBe(OLD)
      expect(displayReadSid()).toBeUndefined()
      expect(files.read(OLD, "a.txt")).toBeNull()
      expect(() =>
        withDisplayReadSid(OLD, () => {
          throw new Error("boom")
        }),
      ).toThrow("boom")
      expect(displayReadSid()).toBeUndefined()
      expect(files.read(OLD, "a.txt")).toBeNull()
    })

    it("display scope: unsafe sid is null", () => {
      const files = owned()
      for (const bad of ["../x", "a/b", ""]) {
        withDisplayReadSid(bad, () => {
          expect(files.read(bad, "a.txt")).toBeNull()
          expect(files.stat(bad, "a.txt")).toBeNull()
        })
      }
      // A safe sid with no session file is null too.
      withDisplayReadSid("0a1d0002-5555-4555-8555-555555555555", () => {
        expect(files.read("0a1d0002-5555-4555-8555-555555555555", "a.txt")).toBeNull()
      })
    })

    it("display scope: another sid is not accepted", () => {
      seedOld()
      const files = owned()
      withDisplayReadSid(SID, () => {
        expect(files.read(OLD, "a.txt")).toBeNull()
      })
    })
  })

  describe("safe reads (O_NOFOLLOW, O_NONBLOCK, fstat)", () => {
    it.skipIf(isWin)("a symlink at the name gives null", () => {
      const files = api()
      expect(files.create(SID, "seed", "s")).toBe("ok")
      const target = join(dir, "outside.txt")
      writeFileSync(target, "secret")
      symlinkSync(target, join(pluginDir(), "link.txt"))
      expect(files.read(SID, "link.txt")).toBeNull()
      expect(files.readHead?.(SID, "link.txt", 10)).toBeNull()
      expect(files.stat(SID, "link.txt")).toBeNull()
    })

    const mkfifo = Bun.which("mkfifo")
    it.skipIf(isWin || mkfifo === null)("a FIFO gives null and does not block", () => {
      const files = api()
      expect(files.create(SID, "seed", "s")).toBe("ok")
      const p = join(pluginDir(), "pipe.txt")
      expect(Bun.spawnSync([mkfifo as string, p]).exitCode).toBe(0)
      const started = Date.now()
      expect(files.read(SID, "pipe.txt")).toBeNull()
      expect(files.readHead?.(SID, "pipe.txt", 10)).toBeNull()
      expect(files.stat(SID, "pipe.txt")).toBeNull()
      expect(Date.now() - started).toBeLessThan(1000)
    })

    it("a dir at the name gives null", () => {
      const files = api()
      expect(files.create(SID, "seed", "s")).toBe("ok")
      mkdirSync(join(pluginDir(), "sub.txt"))
      expect(files.read(SID, "sub.txt")).toBeNull()
      expect(files.readHead?.(SID, "sub.txt", 10)).toBeNull()
      expect(files.stat(SID, "sub.txt")).toBeNull()
    })

    it("a cut on a multi-byte char moves back to the char start", () => {
      const files = api()
      // "a" (1 byte), "é" (2 bytes), "€" (3 bytes), "😀" (4 bytes): 10 bytes.
      expect(files.create(SID, "u.txt", "aé€😀")).toBe("ok")
      const cuts: Array<[number, string]> = [
        [0, ""],
        [1, "a"],
        [2, "a"],
        [3, "aé"],
        [4, "aé"],
        [5, "aé"],
        [6, "aé€"],
        [9, "aé€"],
        [10, "aé€😀"],
        [99, "aé€😀"],
      ]
      for (const [cap, want] of cuts) {
        expect(files.readHead?.(SID, "u.txt", cap)?.text).toBe(want)
        expect(files.read(SID, "u.txt", { maxBytes: cap })).toBe(want)
      }
    })

    it("readHead: bytes is the full size, truncated only when cut", () => {
      const files = api()
      expect(files.create(SID, "b.txt", "x".repeat(100))).toBe("ok")
      expect(files.readHead?.(SID, "b.txt", 10)).toEqual({
        text: "x".repeat(10),
        bytes: 100,
        truncated: true,
      })
      expect(files.readHead?.(SID, "b.txt", 100)).toEqual({
        text: "x".repeat(100),
        bytes: 100,
        truncated: false,
      })
      expect(files.readHead?.(SID, "b.txt", -1)).toBeNull()
      expect(files.readHead?.(SID, "b.txt", Number.NaN)).toBeNull()
      expect(files.readHead?.(SID, "missing.txt", 10)).toBeNull()
    })
  })

  it.skipIf(isWin)("never follows a symlink at the target name", () => {
    const files = api()
    expect(files.create(SID, "seed", "s")).toBe("ok")
    const target = join(dir, "outside.txt")
    writeFileSync(target, "keep")
    symlinkSync(target, join(pluginDir(), "link.txt"))
    expect(["exists", "error"]).toContain(files.create(SID, "link.txt", "evil"))
    expect(readFileSync(target, "utf8")).toBe("keep")
    expect(lstatSync(join(pluginDir(), "link.txt")).isSymbolicLink()).toBe(true)
    // A dangling link is also "exists" (lstat, not stat).
    const gone = join(dir, "gone.txt")
    symlinkSync(gone, join(pluginDir(), "dangling.txt"))
    expect(["exists", "error"]).toContain(files.create(SID, "dangling.txt", "evil"))
    expect(existsSync(gone)).toBe(false)
  })

  it("fork isolation: a create in the fork does not show in the parent", () => {
    const parent = "ma-files-parent"
    const child = "ma-files-child"
    const opts = { model: "m", cwd: "/p", systemHash: "s", toolsHash: "t", agentVersion: "0" }
    const store = SessionStore.open({ ...opts, sid: parent, dir })
    store.appendUser("hello")
    const files = api()
    expect(files.create(parent, "a.txt", "shared")).toBe("ok")
    SessionStore.fork({ ...opts, srcSid: parent, dstSid: child, dir })
    expect(files.read(child, "a.txt")).toBe("shared")
    expect(files.create(child, "b.txt", "fork only")).toBe("ok")
    expect(files.read(parent, "b.txt")).toBeNull()
    expect(files.usage(parent)).toEqual({ files: 1, bytes: 6 })
    // A create in the parent after the fork does not show in the fork.
    expect(files.create(parent, "c.txt", "parent only")).toBe("ok")
    expect(files.read(child, "c.txt")).toBeNull()
  })
})
