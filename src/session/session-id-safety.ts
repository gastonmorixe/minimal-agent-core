/**
 * One check for every session id that becomes part of a file path.
 *
 * Session ids come from many places: a fresh `randomUUID()`, the
 * `--session-id` flag, an ACP client, the session index, or a derived
 * backup id (`<sid>-backup-NN`). Each path builder joins the id into a
 * file name under the sessions dir (or the logs and net-dbg dirs). An id
 * with a path separator or `..` can move that file outside its dir. Each
 * path builder calls {@link assertSafeSessionId} before it joins the id.
 *
 * The rule is a deny list, not a UUID shape check, because real ids are not
 * all UUIDs (backup ids, test ids, ids from other hosts).
 *
 * @module session-id-safety
 */

/** Longest session id a path builder accepts. */
export const MAX_SESSION_ID_LENGTH = 128

/**
 * Return true when `sid` is safe to join into a file name: not empty, at most
 * {@link MAX_SESSION_ID_LENGTH} characters, and no `/`, `\`, `..`, or NUL.
 */
export function isSafeSessionId(sid: string): boolean {
  return (
    sid.length > 0 &&
    sid.length <= MAX_SESSION_ID_LENGTH &&
    !sid.includes("/") &&
    !sid.includes("\\") &&
    !sid.includes("..") &&
    !sid.includes("\0")
  )
}

/**
 * Throw when `sid` is not safe to join into a file name.
 *
 * @param sid - The session id to check
 * @param what - A short name of the caller, for the error message
 */
export function assertSafeSessionId(sid: string, what = "session file"): void {
  if (!isSafeSessionId(sid)) {
    throw new Error(`unsafe session id for ${what}: ${JSON.stringify(sid)}`)
  }
}
