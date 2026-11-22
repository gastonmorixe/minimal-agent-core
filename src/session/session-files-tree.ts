/**
 * Fork helper for the plugin files of a session (`<sid>.files/**`, the
 * `sessions:files` capability). `SessionStore.fork` calls it. The files are
 * immutable after create, so the fork hard-links them: no copy, no extra disk.
 *
 * @module session/session-files-tree
 */

import {
  copyFileSync,
  type Dirent,
  constants as fsConstants,
  linkSync,
  mkdirSync,
  readdirSync,
} from "node:fs"
import { join } from "node:path"

/**
 * Hard-link each file of `src/**` to the same path under `dst/**` (fork of
 * `<sid>.files/`). A link across devices (EXDEV) falls back to a copy. Dirs
 * are made with mode 0700. A file that is already at the destination is kept.
 * Best-effort: each failure is skipped.
 */
export function linkSessionFilesTree(src: string, dst: string): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(src, { withFileTypes: true })
  } catch {
    return // No `<srcSid>.files/`: nothing to fork.
  }
  try {
    mkdirSync(dst, { recursive: true, mode: 0o700 })
  } catch {
    return
  }
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      linkSessionFilesTree(from, to)
      continue
    }
    if (!entry.isFile()) continue
    try {
      linkSync(from, to)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") continue
      try {
        copyFileSync(from, to, fsConstants.COPYFILE_EXCL)
      } catch {
        // best-effort per file
      }
    }
  }
}
