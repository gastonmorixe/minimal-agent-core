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
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
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

import { checkOwnedSessionSid } from "./owned-session.ts"

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

  /** True when `sid` passes the sid rule (see the module doc). Never throws. */
  const sidOk = (sid: unknown): sid is string => {
    try {
      if (opts.isOwnedSession) {
        return checkOwnedSessionSid(sid, opts.sessionsDir, opts.isOwnedSession) === undefined
      }
      return (
        typeof sid === "string" &&
        isSafeSessionId(sid) &&
        existsSync(sessionFilePath(sid, opts.sessionsDir))
      )
    } catch {
      return false // A throwing isOwnedSession: not owned.
    }
  }
  /** The plugin dir of `sid`, or null for a bad or not-owned sid. */
  const dirOf = (sid: string): string | null => {
    if (!sidOk(sid)) return null
    try {
      return join(sessionFilesRoot(opts.sessionsDir, sid), opts.pluginId)
    } catch {
      return null
    }
  }
  /** The file path, or null for a bad sid or name. */
  const pathOf = (sid: string, name: string): string | null => {
    if (!isSafeSessionFileName(name)) return null
    const dir = dirOf(sid)
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

    read(sid: string, name: string): string | null {
      const p = pathOf(sid, name)
      if (!p) return null
      try {
        return readFileSync(p, "utf8")
      } catch {
        return null
      }
    },

    stat(sid: string, name: string): { bytes: number } | null {
      const p = pathOf(sid, name)
      if (!p) return null
      try {
        const st = statSync(p)
        return st.isFile() ? { bytes: st.size } : null
      } catch {
        return null
      }
    },

    usage(sid: string): { files: number; bytes: number } {
      const dir = dirOf(sid)
      return dir ? usageOf(dir) : { files: 0, bytes: 0 }
    },
  }
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
