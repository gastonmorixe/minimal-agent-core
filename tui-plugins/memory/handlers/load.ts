/**
 * Prompt-fragment handler for the `memory` plugin.
 *
 * Runs once at session start (via the loader's `promptFragments` mechanism)
 * and returns the contents of the user's saved memory files, formatted as a
 * `## Saved memories` section that gets appended to the system prompt.
 *
 * Storage layout (per-user, never inside the agent install):
 *   - Global:  ~/.minimal-agent/memory.md
 *   - Project: ~/.minimal-agent/projects/<absolute-cwd>/memory.md
 *
 * The project path mirrors the absolute cwd as a directory tree under
 * `~/.minimal-agent/projects/`. This keeps every project's memories
 * isolated, keeps everything per-user (so collaborators never see them),
 * and never touches the project tree itself (no gitignore needed).
 *
 * If both files are absent or empty, the fragment returns an empty string
 * (the loader will simply not include this fragment in the prompt).
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { PromptFragmentContext } from "../../../src/plugins/types.ts"

/**
 * Resolve the user's home directory. Reads `$HOME` first so tests (and
 * any other runtime override) take effect; falls back to `os.homedir()`
 * which on Bun reads from the passwd database and ignores live env edits.
 */
function home(): string {
  return process.env.HOME ?? homedir()
}

export function globalMemoryPath(h: string = home()): string {
  return join(h, ".minimal-agent", "memory.md")
}

export function projectMemoryPath(
  cwd: string,
  h: string = home(),
): string {
  // Strip the leading slash so `join` doesn't reset to root, then the cwd
  // path becomes a relative tree under `~/.minimal-agent/projects/`.
  const rel = cwd.replace(/^\/+/, "")
  return join(h, ".minimal-agent", "projects", rel, "memory.md")
}

function readIfPresent(path: string): string {
  if (!existsSync(path)) return ""
  try {
    return readFileSync(path, "utf-8").replace(/^\s+|\s+$/g, "")
  } catch {
    return ""
  }
}

export default async function loadMemories(
  ctx: PromptFragmentContext,
): Promise<string> {
  const gPath = globalMemoryPath()
  const pPath = projectMemoryPath(ctx.cwd)

  const g = readIfPresent(gPath)
  const p = readIfPresent(pPath)
  if (!g && !p) return ""

  const out: string[] = ["## Saved memories", ""]
  out.push(
    "Standing instructions and lessons-learned, persisted across sessions.",
    "Snapshot taken at session start : for the live state mid-session,",
    "call `MemoryTool({action: \"list\", scope: ...})` (other agents in",
    "shared worktrees, CLI edits, and your own later saves all bypass",
    "this snapshot).",
    "",
  )
  if (g) {
    out.push(`### Global (\`${gPath}\`)`, "", g, "")
  }
  if (p) {
    out.push(`### Project (\`${pPath}\`)`, "", p, "")
  }
  return out.join("\n")
}
