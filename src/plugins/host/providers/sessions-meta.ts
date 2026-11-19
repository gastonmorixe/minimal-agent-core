/**
 * `sessions:meta` host provider: read and write session titles in the
 * sidecar `index-meta.jsonl` (title plugin SPEC §3d, M3).
 *
 * Each call takes an explicit `sid` that the event handler captured from the
 * event payload. The provider never uses a cached host sid (the memoized
 * capability host keeps the sid of its first build, which can be stale after
 * a session switch or in a host with many sessions).
 *
 * Sid rule (checked before each read and write): the sid is safe for a file
 * name, its session file exists, and the process owns it. "Owns" = the sid
 * of the current session scope, or the resolved process session id, or a sid
 * for which the injected `isOwnedSession` gives true. Else the call rejects
 * with no write.
 *
 * @module plugins/host/providers/sessions-meta
 */

import { existsSync } from "node:fs"

import { currentSessionScope } from "../../../infra/session-scope.ts"
import { peekSessionId } from "../../../session/session-id.ts"
import { isSafeSessionId } from "../../../session/session-id-safety.ts"
import { defaultSessionsDir, sessionFilePath } from "../../../session/session-store.ts"
import {
  appendIndexMeta,
  INDEX_META_MAX_LINE_BYTES,
  INDEX_TITLE_VERSION,
  isIndexTitleRecord,
  readTitleState,
  sanitizeTitle,
  TITLE_ID_MAX_CHARS,
} from "../../../session/session-title.ts"
import type { SessionMetaApi, SessionTitleInput, SessionTitleState } from "../capabilities.ts"

/** Injectable dependencies of {@link createSessionMetaApi}. */
export interface SessionMetaDeps {
  /** Sessions dir. Default: `defaultSessionsDir()` at each call. */
  dir?: string
  /** Clock for the `at` field. Default `Date.now`. */
  now?: () => number
  /**
   * Extra owned sids (for example the live session set of a host with many
   * sessions). The scope sid and the process sid are always owned.
   */
  isOwnedSession?: (sid: string) => boolean
}

/** Why the provider rejected a sid. */
export type SessionMetaSidError = "unsafe" | "not-owned" | "no-session-file"

/** Error of a rejected `getTitle` / `setTitle` call. No write happened. */
export class SessionMetaError extends Error {
  constructor(
    readonly code: SessionMetaSidError | "empty-title" | "invalid-record" | "write-failed",
    message: string,
  ) {
    super(message)
    this.name = "SessionMetaError"
  }
}

/** The sid check of SPEC §3d (M3). Returns the reason, or `undefined` when the sid is accepted. */
export function checkSessionMetaSid(
  sid: unknown,
  dir: string,
  isOwnedSession?: (sid: string) => boolean,
): SessionMetaSidError | undefined {
  if (typeof sid !== "string" || !isSafeSessionId(sid)) return "unsafe"
  const owned =
    sid === currentSessionScope()?.sid ||
    sid === peekSessionId() ||
    (isOwnedSession?.(sid) ?? false)
  if (!owned) return "not-owned"
  if (!existsSync(sessionFilePath(sid, dir))) return "no-session-file"
  return undefined
}

/** B1: cut a `model` / `provider` string to {@link TITLE_ID_MAX_CHARS} (a non-string stays, and fails the record check). */
function capId(s: unknown): unknown {
  return typeof s === "string" ? s.slice(0, TITLE_ID_MAX_CHARS) : s
}

/**
 * A3: the `usage` field to write. `JSON.stringify` writes `null` for NaN or
 * Infinity, and every reader then rejects the line (silent title loss). So a
 * non-finite or negative number is dropped before the write: a bad `costUsd`
 * drops only `costUsd`; a bad token count drops the whole `usage`. The title
 * is still saved. A wrong type (not a number) stays and fails the record check.
 */
function usageField(u: SessionTitleInput["usage"]): { usage?: unknown } {
  if (typeof u !== "object" || u === null) return u === undefined ? {} : { usage: u }
  const { inputTokens, outputTokens, costUsd } = u as unknown as Record<string, unknown>
  const typed = typeof inputTokens === "number" && typeof outputTokens === "number"
  if (!typed || (costUsd !== undefined && typeof costUsd !== "number")) return { usage: u }
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0
  if (!ok(inputTokens) || !ok(outputTokens)) return {}
  if (costUsd === undefined || ok(costUsd)) return { usage: u }
  const { costUsd: _dropped, ...rest } = u
  return { usage: rest }
}

/** Build the `sessions:meta` API (see {@link SessionMetaApi}). */
export function createSessionMetaApi(deps: SessionMetaDeps = {}): SessionMetaApi {
  const dirOf = () => deps.dir ?? defaultSessionsDir()
  const now = deps.now ?? (() => Date.now())

  const assertSid = (sid: unknown, dir: string): string => {
    const err = checkSessionMetaSid(sid, dir, deps.isOwnedSession)
    if (err) throw new SessionMetaError(err, `sessions:meta: sid rejected (${err})`)
    return sid as string
  }

  return {
    getTitle(sid: string): SessionTitleState {
      const dir = dirOf()
      return readTitleState(assertSid(sid, dir), dir)
    },

    async setTitle(input: SessionTitleInput): Promise<void> {
      const dir = dirOf()
      const sid = assertSid(input?.sid, dir)
      const title = sanitizeTitle(typeof input.title === "string" ? input.title : "")
      if (title.length === 0)
        throw new SessionMetaError("empty-title", "sessions:meta: empty title")
      // A user title always wins (SPEC §3d, §8): no `ai` line after a user
      // title. Not an error: the call returns with no write.
      if (input.source === "ai" && readTitleState(sid, dir).user !== undefined) return
      const rec: Record<string, unknown> = {
        kind: "title",
        v: INDEX_TITLE_VERSION,
        sid,
        title,
        source: input.source,
        ...(input.model !== undefined ? { model: capId(input.model) } : {}),
        ...(input.provider !== undefined ? { provider: capId(input.provider) } : {}),
        ...usageField(input.usage),
        at: new Date(now()).toISOString(),
      }
      if (!isIndexTitleRecord(rec)) {
        throw new SessionMetaError("invalid-record", "sessions:meta: invalid title input")
      }
      if (Buffer.byteLength(JSON.stringify(rec)) + 1 > INDEX_META_MAX_LINE_BYTES) {
        throw new SessionMetaError("invalid-record", "sessions:meta: title line too large")
      }
      if (!appendIndexMeta(rec, dir)) {
        throw new SessionMetaError("write-failed", "sessions:meta: sidecar append failed")
      }
    },
  }
}
