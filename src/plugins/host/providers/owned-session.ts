/**
 * The owned-session rule of the host providers that take an explicit `sid`
 * (`sessions:meta`, `sessions:files`).
 *
 * A sid is accepted when it is safe for a file name, the process owns it, and
 * its session file (`<dir>/<sid>.jsonl`) exists. "Owns" = the sid of the
 * current session scope, or the resolved process session id, or a sid for
 * which the injected `isOwnedSession` gives true.
 *
 * @module plugins/host/providers/owned-session
 */

import { existsSync } from "node:fs"

import { currentSessionScope } from "../../../infra/session-scope.ts"
import { peekSessionId } from "../../../session/session-id.ts"
import { isSafeSessionId } from "../../../session/session-id-safety.ts"
import { sessionFilePath } from "../../../session/session-store.ts"

/** The sid of the display call that runs now, or `undefined`. */
let displaySid: string | undefined

/**
 * Run `fn` with a read-only display scope for `sid`. During the sync call,
 * `sessions:files` `read`, `readHead`, `stat` and `usage` also accept `sid`
 * when it is safe and its session file exists, also when the process does not
 * own it (a dump of an old session). `create` keeps the full owned rule. Only
 * the sideband display API sets the scope. The scope ends when `fn` returns
 * or throws. `fn` must be sync: a promise that it gives runs outside the scope.
 *
 * @param sid - The sid of the text. `undefined` runs `fn` with no scope.
 * @param fn - The sync call.
 */
export function withDisplayReadSid<T>(sid: string | undefined, fn: () => T): T {
  const prev = displaySid
  displaySid = sid
  try {
    return fn()
  } finally {
    displaySid = prev
  }
}

/** The sid of the display scope that runs now (see {@link withDisplayReadSid}), or `undefined`. */
export function displayReadSid(): string | undefined {
  return displaySid
}

/** Why the owned-session rule rejected a sid. */
export type OwnedSessionSidError = "unsafe" | "not-owned" | "no-session-file"

/**
 * Check `sid` against the owned-session rule (see the module doc). Returns the
 * reason, or `undefined` when the sid is accepted.
 *
 * @param sid - The sid from the plugin (not trusted: any value)
 * @param dir - The sessions dir that holds `<sid>.jsonl`
 * @param isOwnedSession - Extra owned sids. The scope sid and the process sid are always owned.
 */
export function checkOwnedSessionSid(
  sid: unknown,
  dir: string,
  isOwnedSession?: (sid: string) => boolean,
): OwnedSessionSidError | undefined {
  if (typeof sid !== "string" || !isSafeSessionId(sid)) return "unsafe"
  const owned =
    sid === currentSessionScope()?.sid ||
    sid === peekSessionId() ||
    (isOwnedSession?.(sid) ?? false)
  if (!owned) return "not-owned"
  if (!existsSync(sessionFilePath(sid, dir))) return "no-session-file"
  return undefined
}
