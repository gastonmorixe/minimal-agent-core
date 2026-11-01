import { randomUUID } from "node:crypto"

import { describe, expect, test } from "bun:test"

import { FileLogSink } from "../logging/log-file.ts"
import { formatSessionDirName, netDbgSessionDir } from "../logging/net-dbg.ts"

import { defaultBlobsDir } from "./blob-store.ts"
import { eventLogFilePath } from "./event-log.ts"
import { fileTrackingPath, isSafeSid } from "./file-tracking-store.ts"
import { queueFilePath } from "./queue-store.ts"
import { assertSafeSessionId, isSafeSessionId, MAX_SESSION_ID_LENGTH } from "./session-id-safety.ts"
import { sessionFilePath } from "./session-store.ts"

const DIR = "/sessions"

const BAD_IDS: readonly string[] = [
  "",
  "../x",
  "../../x",
  "a/b",
  "/abs",
  "a\\b",
  "..",
  "a..b",
  "a\0b",
  "x".repeat(MAX_SESSION_ID_LENGTH + 1),
]

const GOOD_IDS: readonly string[] = [
  randomUUID(),
  "019a4c3e-7b2f-4d1a-9c3e-0123456789ab",
  // Backup id shape from session-history-edit.ts.
  `${randomUUID()}-backup-01`,
  // Short ids that tests and other hosts use.
  "s1",
  "test-sid",
  "abc_123.v2",
  "x".repeat(MAX_SESSION_ID_LENGTH),
]

/** Every function that joins a session id into a file path. */
const PATH_BUILDERS: ReadonlyArray<readonly [string, (sid: string) => string]> = [
  ["sessionFilePath", (sid) => sessionFilePath(sid, DIR)],
  ["eventLogFilePath", (sid) => eventLogFilePath(sid, DIR)],
  ["queueFilePath", (sid) => queueFilePath(sid, DIR)],
  ["fileTrackingPath", (sid) => fileTrackingPath(sid, DIR)],
  ["defaultBlobsDir", (sid) => defaultBlobsDir(sid, DIR)],
  ["formatSessionDirName", (sid) => formatSessionDirName(0, new Date(0), sid)],
  [
    "netDbgSessionDir",
    (sid) => netDbgSessionDir(0, new Date(0), sid, { MINIMAL_AGENT_HOME: "/home-x" }),
  ],
  ["FileLogSink.path", (sid) => new FileLogSink(sid, { dir: "/logs" }).path],
]

describe("isSafeSessionId", () => {
  for (const sid of BAD_IDS) {
    test(`rejects ${JSON.stringify(sid.slice(0, 20))} (length ${sid.length})`, () => {
      expect(isSafeSessionId(sid)).toBe(false)
      expect(() => assertSafeSessionId(sid)).toThrow(/unsafe session id/)
    })
  }
  for (const sid of GOOD_IDS) {
    test(`accepts ${JSON.stringify(sid.slice(0, 20))} (length ${sid.length})`, () => {
      expect(isSafeSessionId(sid)).toBe(true)
      expect(() => assertSafeSessionId(sid)).not.toThrow()
    })
  }
  test("isSafeSid in file-tracking-store uses the same rule", () => {
    for (const sid of BAD_IDS) expect(isSafeSid(sid)).toBe(false)
    for (const sid of GOOD_IDS) expect(isSafeSid(sid)).toBe(true)
  })
})

describe("session path builders reject unsafe ids", () => {
  test('sessionFilePath("../x") and eventLogFilePath("a/b") throw', () => {
    expect(() => sessionFilePath("../x", DIR)).toThrow(/unsafe session id/)
    expect(() => eventLogFilePath("a/b", DIR)).toThrow(/unsafe session id/)
  })

  for (const [name, build] of PATH_BUILDERS) {
    test(`${name} throws on every bad id`, () => {
      for (const sid of BAD_IDS) expect(() => build(sid)).toThrow(/unsafe session id/)
    })
    test(`${name} accepts every real id format and keeps it in the file name`, () => {
      for (const sid of GOOD_IDS) expect(build(sid)).toContain(sid)
    })
  }
})
