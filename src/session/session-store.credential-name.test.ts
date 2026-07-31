/**
 * MetaRecord.credentialName persistence + same-sid resume backfill.
 *
 * Kept out of session-store.test.ts to stay under the max-lines budget.
 *
 * @module session/session-store.credential-name.test
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { type MetaRecord, SessionStore, sessionFilePath } from "./session-store.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-session-cred-"))
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

const baseOpenOpts = {
  model: "test-model-1",
  cwd: "/tmp/example",
  systemHash: "deadbeef",
  toolsHash: "cafebabe",
  agentVersion: "test",
}

describe("MetaRecord.credentialName", () => {
  it("open() stores credentialName when passed", () => {
    const dir = tmp()
    const store = SessionStore.open({
      ...baseOpenOpts,
      sid: "ma-cred-open",
      dir,
      credentialName: "pinned-cred-3",
    })
    const meta = readJsonl(store.path)[0] as MetaRecord
    expect(meta.credentialName).toBe("pinned-cred-3")
  })

  it("open() omits credentialName when not passed (backward compat)", () => {
    const dir = tmp()
    const store = SessionStore.open({ ...baseOpenOpts, sid: "ma-no-cred-open", dir })
    const meta = readJsonl(store.path)[0] as MetaRecord
    expect(meta.credentialName).toBeUndefined()
  })

  it("fork() stores credentialName when passed (resume pin survival)", () => {
    const dir = tmp()
    const srcSid = "ma-cred-fork-src"
    const dstSid = "ma-cred-fork-dst"
    SessionStore.open({
      ...baseOpenOpts,
      sid: srcSid,
      dir,
      credentialName: "pinned-cred-3",
    })
    SessionStore.fork({
      ...baseOpenOpts,
      srcSid,
      dstSid,
      dir,
      credentialName: "pinned-cred-3",
    })
    const meta = readJsonl(sessionFilePath(dstSid, dir))[0] as MetaRecord
    expect(meta.credentialName).toBe("pinned-cred-3")
  })

  it("fork() omits credentialName when not passed (backward compat)", () => {
    const dir = tmp()
    const srcSid = "ma-no-cred-fork-src"
    const dstSid = "ma-no-cred-fork-dst"
    SessionStore.open({ ...baseOpenOpts, sid: srcSid, dir })
    SessionStore.fork({ ...baseOpenOpts, srcSid, dstSid, dir })
    const meta = readJsonl(sessionFilePath(dstSid, dir))[0] as MetaRecord
    expect(meta.credentialName).toBeUndefined()
  })

  it("REGRESSION: open(existsOk) backfills meta.credentialName on same-sid resume", () => {
    const dir = tmp()
    const sid = "ma-cred-same-sid"
    SessionStore.open({ ...baseOpenOpts, sid, dir })
    expect((readJsonl(sessionFilePath(sid, dir))[0] as MetaRecord).credentialName).toBeUndefined()

    SessionStore.open({
      ...baseOpenOpts,
      sid,
      dir,
      existsOk: true,
      credentialName: "pinned-cred-3",
    })
    const meta = readJsonl(sessionFilePath(sid, dir))[0] as MetaRecord
    expect(meta.credentialName).toBe("pinned-cred-3")
  })

  it("open(existsOk) does not overwrite an existing meta.credentialName", () => {
    const dir = tmp()
    const sid = "ma-cred-same-sid-stable"
    SessionStore.open({
      ...baseOpenOpts,
      sid,
      dir,
      credentialName: "pinned-cred-3",
    })
    SessionStore.open({
      ...baseOpenOpts,
      sid,
      dir,
      existsOk: true,
      credentialName: "pinned-cred-2",
    })
    const meta = readJsonl(sessionFilePath(sid, dir))[0] as MetaRecord
    expect(meta.credentialName).toBe("pinned-cred-3")
  })
})
