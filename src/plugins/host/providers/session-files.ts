/**
 * `sessions:files` provider: immutable files of one plugin in one session.
 *
 * The root is `<sessionsDir>/<sid>.files/<pluginId>/`. Core owns the root, so
 * a fork of the session links the files (`SessionStore.fork`), and the
 * cleanup of an unused session removes them (`cleanupIfUnused`). The plugin
 * gets no path, only a name inside its own dir.
 *
 * Rules:
 * - `sid` passes {@link assertSafeSessionId}, and its session file
 *   (`<sessionsDir>/<sid>.jsonl`) exists. With an `isOwnedSession` option
 *   (the core plugin host always gives one), the process must also own the
 *   sid: the sid of the current session scope, the resolved process session
 *   id, or a sid for which `isOwnedSession` gives true (the rule of
 *   `sessions:meta`, see `owned-session.ts`). A rejected sid gives `"error"`
 *   (create, no dir is made), `null` (read, stat) or zeros (usage).
 * - Display scope: during a sync sideband display call for a sid
 *   (`withDisplayReadSid`), `read`, `readHead`, `stat` and `usage` also
 *   accept that sid when it is safe and its session file exists, also when
 *   the process does not own it. `create` keeps the full rule. Only a
 *   trusted caller opens this scope: a host, or a plugin with
 *   `sessions:read` (see `sidebandForPlugin`).
 * - A read opens the file with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, then
 *   checks `fstat`: only a regular file is read. A symlink, a FIFO, a socket
 *   or a dir gives null. A FIFO never blocks the event loop.
 * - Limits of the safe open: `O_NOFOLLOW` checks only the last path part, so
 *   a symlinked `<sid>.files` or `<sid>.files/<pluginId>` dir is followed. On
 *   Windows the flags are 0 (Node has no `O_NOFOLLOW` there), so a symlink
 *   is followed and there is no symlink guard.
 * - `name` and `pluginId` agree with {@link SESSION_FILE_NAME_RE} and hold
 *   no `..`.
 * - Dirs are 0700 and files are 0600. The dirs are made on the first create.
 * - `create` writes a tmp file in the same dir, fsyncs it, links it to the
 *   final name (`linkSync`, so the final name is exclusive: EEXIST gives
 *   `"exists"`), unlinks the tmp file, and fsyncs the dir. It never
 *   overwrites and never throws.
 * - The caps (bytes for each file, bytes for each `<sid>.files/<pluginId>`)
 *   are read from the DISK at each create. Two API instances (for example a
 *   UI host and the core host) can write the same dir, so no counter stays
 *   in RAM.
 *
 * @module plugins/host/providers/session-files
 */

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type {
  SessionFileCreate,
  SessionFilesApi,
} from "@minimal-agent/core/plugin-api/types/host-capabilities"

import { assertSafeSessionId, isSafeSessionId } from "../../../session/session-id-safety.ts"
import { sessionFilePath } from "../../../session/session-store.ts"

import { checkOwnedSessionSid, displayReadSid } from "./owned-session.ts"

export type {
  SessionFileCreate,
  SessionFilesApi,
} from "@minimal-agent/core/plugin-api/types/host-capabilities"

/** The rule for a file name and for the plugin id dir. Also: no `..`. */
export const SESSION_FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Default byte cap for one file: 32 MB. */
export const DEFAULT_SESSION_FILE_MAX_BYTES = 32 * 1024 * 1024

/** Default byte cap for one `<sid>.files/<pluginId>` dir: 256 MB. */
export const DEFAULT_SESSION_FILES_MAX_PLUGIN_BYTES = 256 * 1024 * 1024

/** Byte caps of {@link createSessionFilesApi}. */
export interface SessionFilesCaps {
  /** Bytes for each file. Default {@link DEFAULT_SESSION_FILE_MAX_BYTES}. */
  maxFileBytes?: number
  /** Bytes for each `<sid>.files/<pluginId>` dir. Default {@link DEFAULT_SESSION_FILES_MAX_PLUGIN_BYTES}. */
  maxPluginBytes?: number
}

/** Options of {@link createSessionFilesApi}. */
export interface SessionFilesOptions {
  /** The sessions dir (`<home>/sessions`). */
  sessionsDir: string
  /** The plugin id: the name of the plugin dir under `<sid>.files/`. */
  pluginId: string
  caps?: SessionFilesCaps
  /**
   * The owned-session rule. When given, a sid must be owned by this process:
   * the current scope sid, the resolved process sid, or a sid for which this
   * function gives true (for example the live session set of the host). The
   * core plugin host always gives it. When absent (a host that builds the API
   * itself), only the safe-sid and session-file-exists checks apply.
   */
  isOwnedSession?: (sid: string) => boolean
}

/** True when `name` is a safe file name (or plugin id) for this API. */
export function isSafeSessionFileName(name: string): boolean {
  return SESSION_FILE_NAME_RE.test(name) && !name.includes("..")
}

/** The dir of all plugin files of one session: `<sessionsDir>/<sid>.files`. */
export function sessionFilesRoot(sessionsDir: string, sid: string): string {
  assertSafeSessionId(sid, "session files")
  return join(sessionsDir, `${sid}.files`)
}

/**
 * Build the `sessions:files` API of one plugin.
 *
 * @throws When `pluginId` does not agree with {@link SESSION_FILE_NAME_RE}
 * (a host error, not a plugin error).
 */
export function createSessionFilesApi(opts: SessionFilesOptions): SessionFilesApi {
  if (!isSafeSessionFileName(opts.pluginId)) {
    throw new Error(`unsafe plugin id for session files: ${JSON.stringify(opts.pluginId)}`)
  }
  const maxFileBytes = opts.caps?.maxFileBytes ?? DEFAULT_SESSION_FILE_MAX_BYTES
  const maxPluginBytes = opts.caps?.maxPluginBytes ?? DEFAULT_SESSION_FILES_MAX_PLUGIN_BYTES

  /** True when `sid` exists on the disk and is safe. Never throws. */
  const sidExists = (sid: unknown): sid is string =>
    typeof sid === "string" &&
    isSafeSessionId(sid) &&
    existsSync(sessionFilePath(sid, opts.sessionsDir))
  /**
   * True when `sid` passes the sid rule (see the module doc). With `forRead`,
   * the sid of the display scope that runs now also passes (no write).
   * Never throws.
   */
  const sidOk = (sid: unknown, forRead = false): sid is string => {
    try {
      if (forRead && sid !== undefined && sid === displayReadSid()) return sidExists(sid)
      if (opts.isOwnedSession) {
        return checkOwnedSessionSid(sid, opts.sessionsDir, opts.isOwnedSession) === undefined
      }
      return sidExists(sid)
    } catch {
      return false // A throwing isOwnedSession: not owned.
    }
  }
  /** The plugin dir of `sid`, or null for a bad or not-owned sid. */
  const dirOf = (sid: string, forRead = false): string | null => {
    if (!sidOk(sid, forRead)) return null
    try {
      return join(sessionFilesRoot(opts.sessionsDir, sid), opts.pluginId)
    } catch {
      return null
    }
  }
  /** The file path, or null for a bad sid or name. */
  const pathOf = (sid: string, name: string, forRead = false): string | null => {
    if (!isSafeSessionFileName(name)) return null
    const dir = dirOf(sid, forRead)
    return dir ? join(dir, name) : null
  }

  const usageOf = (dir: string): { files: number; bytes: number } => {
    let files = 0
    let bytes = 0
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return { files, bytes }
    }
    for (const e of entries) {
      // A dot name is a tmp file of a create in flight. It is not a file yet.
      if (!e.isFile() || e.name.startsWith(".")) continue
      try {
        bytes += statSync(join(dir, e.name)).size
        files += 1
      } catch {
        // Removed between readdir and stat.
      }
    }
    return { files, bytes }
  }

  return {
    create(sid: string, name: string, data: string): SessionFileCreate {
      const dir = dirOf(sid)
      if (!dir || !isSafeSessionFileName(name) || typeof data !== "string") return "error"
      const final = join(dir, name)
      const bytes = Buffer.byteLength(data, "utf8")
      if (bytes > maxFileBytes) return "over-cap"
      try {
        // lstat: a symlink at the name is "exists". It is never followed.
        lstatSync(final)
        return "exists"
      } catch {
        // Missing: continue.
      }
      if (usageOf(dir).bytes + bytes > maxPluginBytes) return "over-cap"
      const tmp = join(dir, `.tmp-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`)
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const fd = openSync(tmp, "wx", 0o600)
        try {
          writeFileSync(fd, data, "utf8")
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        try {
          linkSync(tmp, final)
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "error"
        }
        fsyncDir(dir)
        return "ok"
      } catch {
        return "error"
      } finally {
        try {
          unlinkSync(tmp)
        } catch {
          // Not made, or already gone.
        }
      }
    },

    read(sid: string, name: string, readOpts?: { maxBytes?: number }): string | null {
      const p = pathOf(sid, name, true)
      if (!p) return null
      if (readOpts?.maxBytes === undefined) {
        return withRegularFile(p, (fd, size) => readUtf8Head(fd, size, size).text)
      }
      const cap = byteCap(readOpts.maxBytes)
      if (cap === undefined) return null
      return withRegularFile(p, (fd, size) => readUtf8Head(fd, size, cap).text)
    },

    readHead(
      sid: string,
      name: string,
      maxBytes: number,
    ): { text: string; bytes: number; truncated: boolean } | null {
      const cap = byteCap(maxBytes)
      if (cap === undefined) return null
      const p = pathOf(sid, name, true)
      if (!p) return null
      return withRegularFile(p, (fd, size) => readUtf8Head(fd, size, cap))
    },

    stat(sid: string, name: string): { bytes: number } | null {
      const p = pathOf(sid, name, true)
      if (!p) return null
      return withRegularFile(p, (_fd, size) => ({ bytes: size }))
    },

    usage(sid: string): { files: number; bytes: number } {
      const dir = dirOf(sid, true)
      return dir ? usageOf(dir) : { files: 0, bytes: 0 }
    },
  }
}

/**
 * The open flags of a read: read only, do not follow a symlink at the name,
 * do not block on a FIFO. A platform with no flag gets 0 for it.
 */
const READ_FLAGS =
  (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)

/**
 * Open `p` for a read and call `fn` with the fd and the file size, only when
 * the open fd is a regular file. A symlink, a FIFO, a socket, a dir or any
 * error gives null. The fd is closed in each case. Never throws.
 */
function withRegularFile<T>(p: string, fn: (fd: number, size: number) => T): T | null {
  let fd: number
  try {
    fd = openSync(p, READ_FLAGS)
  } catch {
    return null
  }
  try {
    const st = fstatSync(fd)
    return st.isFile() ? fn(fd, st.size) : null
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

/** A valid byte cap (a whole number, 0 or more), or `undefined`. */
function byteCap(v: unknown): number | undefined {
  if (typeof v !== "number" || Number.isNaN(v) || v < 0) return undefined
  return Math.floor(v)
}

/**
 * The end of the last whole UTF-8 code point in `buf[0, end)`. A cut in a
 * multi-byte char moves back to the start of that char.
 */
function utf8Boundary(buf: Uint8Array, end: number): number {
  let i = end - 1
  // Step back over the continuation bytes (10xxxxxx), at most 3.
  while (i >= 0 && end - i < 4 && ((buf[i] as number) & 0xc0) === 0x80) i--
  if (i < 0) return end
  const lead = buf[i] as number
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return i + need > end ? i : end
}

/**
 * Read at most `cap` bytes of the open file `fd` (of `size` bytes), cut back
 * to a UTF-8 code point boundary when the read stops before the end.
 * `truncated` is true when the text is shorter than the file.
 */
function readUtf8Head(
  fd: number,
  size: number,
  cap: number,
): { text: string; bytes: number; truncated: boolean } {
  const want = Math.min(size, cap)
  const buf = Buffer.alloc(want)
  let got = 0
  while (got < want) {
    const n = readSync(fd, buf, got, want - got, got)
    if (n <= 0) break
    got += n
  }
  const cut = got < size ? utf8Boundary(buf, got) : got
  return { text: buf.toString("utf8", 0, cut), bytes: size, truncated: cut < size }
}

/** Fsync a dir, so the new link is on the disk. Some platforms cannot: ignore. */
function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, "r")
    fsyncSync(fd)
  } catch {
    // Not possible on this platform (for example Windows).
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}
