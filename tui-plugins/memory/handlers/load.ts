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
 * ## Summary-aware injection (opt-in)
 *
 * When `plugins.memory.summary.enabled = true` in user config AND the
 * memory file exceeds the configured size thresholds, this handler
 * delegates to {@link refreshAndRender}: it may regenerate
 * `memory.summary.md` via a cheap LLM call (blocking session start
 * briefly), then injects the summary plus a "Recent saves" tail of
 * bullets newer than the regen cutoff.
 *
 * When disabled (default) or below thresholds, falls back to verbatim
 * memory.md injection — the original behavior.
 *
 * See `docs/changes/2026-05-14-feat-memory-summary-refresh.md` for the
 * full design rationale.
 *
 * If both memory files are absent or empty, the fragment returns an empty
 * string (the loader will simply not include this fragment in the prompt).
 */

import { existsSync, readFileSync } from "node:fs"

import type { PromptFragmentContext } from "../../../src/plugins/types.ts"
import { loadMemorySummaryConfig, type MemorySummaryConfig } from "../lib/memory-config.ts"
import {
  globalMemoryPath as storeGlobalMemoryPath,
  projectMemoryPath as storeProjectMemoryPath,
} from "../lib/store.ts"
import { refreshAndRender, summaryPathFor } from "../lib/summary-refresh.ts"

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

/**
 * Injectable dependencies for {@link loadMemories}, primarily so tests
 * can override the config loader and skip the LLM call. Production
 * callers pass nothing.
 */
export interface LoadMemoriesDeps {
  /** Override config loader. Defaults to {@link loadMemorySummaryConfig}. */
  loadConfig?: () => MemorySummaryConfig
  /**
   * Override refreshAndRender. Defaults to the real implementation
   * (which may call the LLM). Tests pass a fake to avoid network IO.
   */
  refresh?: typeof refreshAndRender
}

/**
 * Render a per-scope section. When summary is enabled AND the scope is
 * one of `"global"|"project"`, we go through `refreshAndRender` which
 * may regenerate the on-disk summary. Otherwise we fall back to the
 * legacy verbatim path.
 */
async function renderScopeSection(
  label: string,
  memoryPath: string,
  scope: "global" | "project",
  cfg: MemorySummaryConfig,
  refresh: typeof refreshAndRender,
): Promise<string[]> {
  const verbatim = readIfPresent(memoryPath)
  if (!verbatim) return []

  if (!cfg.enabled) {
    // Fast path — legacy behavior, no config/summary surface.
    return [`### ${label} (\`${memoryPath}\`)`, "", verbatim, ""]
  }

  // Summary-aware path. refreshAndRender may regen the summary file in
  // place. Any failure inside falls back to verbatim by construction.
  const result = await refresh({
    scope,
    memoryPath,
    summaryPath: summaryPathFor(memoryPath),
    cfg,
  })
  if (!result.text) return []
  return [`### ${label} (\`${memoryPath}\`)`, "", result.text, ""]
}

export default async function loadMemories(
  ctx: PromptFragmentContext,
  deps: LoadMemoriesDeps = {},
): Promise<string> {
  const gPath = globalMemoryPath()
  const pPath = projectMemoryPath(ctx.cwd)
  const cfg = (deps.loadConfig ?? loadMemorySummaryConfig)()
  const refresh = deps.refresh ?? refreshAndRender

  const globalSection = await renderScopeSection("Global", gPath, "global", cfg, refresh)
  const projectSection = await renderScopeSection("Project", pPath, "project", cfg, refresh)

  if (globalSection.length === 0 && projectSection.length === 0) return ""

  const out: string[] = ["## Saved memories", ""]
  out.push(
    "Standing instructions and lessons-learned, persisted across sessions.",
    "Snapshot taken at session start : for the live state mid-session,",
    'call `MemoryTool({action: "list", scope: ...})` (other agents in',
    "shared worktrees, CLI edits, and your own later saves all bypass",
    "this snapshot).",
    "",
  )
  if (cfg.enabled) {
    out.push(
      "Below the section headers, content may be a CONDENSED summary",
      "(with `Sources: #id1, #id2` citing the underlying bullets).",
      "For the full body of any bullet referenced by id, call",
      '`MemoryTool({action: "read", scope, id})`. Bullets added since the',
      'last regen are listed verbatim under "Recent saves".',
      "",
    )
  }
  out.push(...globalSection)
  out.push(...projectSection)
  return out.join("\n")
}
