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
 * Path resolution is delegated to `lib/store.ts` so the namespace env
 * var (`MINIMAL_AGENT_MEMORY_NAMESPACE`) and any future layout changes
 * stay in one place. When the namespace env var is set, the paths
 * above become `~/.minimal-agent/namespaces/<ns>/memory.md` and
 * `~/.minimal-agent/namespaces/<ns>/projects/<cwd>/memory.md`.
 *
 * If both files are absent or empty, the fragment returns an empty string
 * (the loader will simply not include this fragment in the prompt).
 */

import { existsSync, readFileSync } from "node:fs"

import type { PromptFragmentContext } from "../../../src/plugins/types.ts"
import {
  globalMemoryPath as storeGlobalMemoryPath,
  projectMemoryPath as storeProjectMemoryPath,
} from "../lib/store.ts"

/**
 * Resolve the global memory file. Optional `h` is a `$HOME` override
 * (legacy string form, kept for back-compat with existing tests and
 * any external caller); when omitted, the store reads `$HOME` from the
 * process env. Namespace handling is fully delegated to `lib/store.ts`
 * (driven by `MINIMAL_AGENT_MEMORY_NAMESPACE`).
 */
export function globalMemoryPath(h?: string): string {
  return storeGlobalMemoryPath(h !== undefined ? { home: h } : undefined)
}

/**
 * Resolve the project memory file for a given cwd. See
 * {@link globalMemoryPath} for the `h` parameter semantics.
 */
export function projectMemoryPath(cwd: string, h?: string): string {
  return storeProjectMemoryPath(cwd, h !== undefined ? { home: h } : undefined)
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
