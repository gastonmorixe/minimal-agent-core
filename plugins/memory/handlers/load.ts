/**
 * Prompt-fragment handler for the `memory` plugin.
 *
 * Runs once at session start (via the loader's `promptFragments`
 * mechanism). Returns a chunk of markdown that gets appended to the
 * system prompt.
 *
 * ## Default behavior: NO injection
 *
 * As of this version the plugin does NOT dump memory contents into the
 * system prompt by default. The `inject` mode is `"none"`, and this
 * handler returns an empty string. Memories saturate the context window
 * if they grow large, and the model already knows about the
 * `MemoryTool` from the plugin's static `PROMPT.md` (which is loaded
 * separately). The model is taught to query memory on demand.
 *
 * Users who want the old verbatim dump (or the experimental summary
 * mode) opt in via `~/.minimal-agent/config.jsonc`:
 *
 * ```jsonc
 * { "plugins": { "memory": { "inject": "verbatim" } } }
 * ```
 *
 * Three modes are supported:
 *
 *   - `"none"`     (default): return empty string. PROMPT.md still loads.
 *   - `"verbatim"`: full memory.md text, formatted as a
 *                    `## Saved memories` block.
 *   - `"summary"` : LLM-derived condensed view via
 *                    {@link refreshAndRender}.
 *
 * Internally, each mode is implemented as an {@link InjectStrategy}
 * (strategy pattern). The handler dispatches through a static lookup
 * table, so adding a new mode means adding one strategy function and
 * one entry to the table.
 *
 * Storage layout (per-user, never inside the agent install):
 *   - Global:  ~/.minimal-agent/memory.md
 *   - Project: ~/.minimal-agent/projects/<absolute-cwd>/memory.md
 *
 * If both memory files are absent or empty, the fragment returns an
 * empty string (the loader will simply not include this fragment).
 *
 * Path resolution is delegated to `lib/store.ts` so the namespace env
 * var (`MINIMAL_AGENT_MEMORY_NAMESPACE`) stays in one place.
 */

import { existsSync, readFileSync } from "node:fs"

import type { PromptFragmentContext } from "../../../src/plugins/types.ts"
import {
  loadMemoryConfig,
  type MemoryConfig,
  type MemoryInjectMode,
} from "../lib/memory-config.ts"
import {
  globalMemoryPath as storeGlobalMemoryPath,
  projectMemoryPath as storeProjectMemoryPath,
} from "../lib/store.ts"
import { refreshAndRender, summaryPathFor } from "../lib/summary-refresh.ts"

// ---------------------------------------------------------------------------
// Path re-exports (kept for back-compat with existing callers / tests)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

function readIfPresent(path: string): string {
  if (!existsSync(path)) return ""
  try {
    return readFileSync(path, "utf-8").replace(/^\s+|\s+$/g, "")
  } catch {
    return ""
  }
}

// ---------------------------------------------------------------------------
// Strategy pattern: one function per inject mode
// ---------------------------------------------------------------------------

/**
 * Per-scope renderer. Returns the markdown LINES that should appear
 * under the section header for this scope, or `[]` to omit the scope
 * entirely.
 *
 * Strategies are pure-ish: they read from disk and (for "summary") may
 * call the LLM, but they don't print anywhere directly. Composition is
 * done by {@link loadMemories}.
 */
type InjectStrategy = (args: {
  label: string
  memoryPath: string
  scope: "global" | "project"
  cfg: MemoryConfig
  refresh: typeof refreshAndRender
}) => Promise<string[]>

/** Strategy: emit nothing. The model relies on `MemoryTool` to query. */
const noneStrategy: InjectStrategy = async () => []

/** Strategy: emit the raw `memory.md` text verbatim. Legacy behavior. */
const verbatimStrategy: InjectStrategy = async ({ label, memoryPath }) => {
  const verbatim = readIfPresent(memoryPath)
  if (!verbatim) return []
  return [`### ${label} (\`${memoryPath}\`)`, "", verbatim, ""]
}

/** Strategy: invoke the LLM-derived summary pipeline. Opt-in. */
const summaryStrategy: InjectStrategy = async ({
  label,
  memoryPath,
  scope,
  cfg,
  refresh,
}) => {
  // refreshAndRender reads the file itself, so we don't pre-read here.
  // It also already short-circuits if the file is missing/empty.
  const result = await refresh({
    scope,
    memoryPath,
    summaryPath: summaryPathFor(memoryPath),
    cfg: cfg.summary,
  })
  if (!result.text) return []
  return [`### ${label} (\`${memoryPath}\`)`, "", result.text, ""]
}

const STRATEGIES: Readonly<Record<MemoryInjectMode, InjectStrategy>> = {
  none: noneStrategy,
  verbatim: verbatimStrategy,
  summary: summaryStrategy,
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link loadMemories}, primarily so tests
 * can override the config loader and skip the LLM call. Production
 * callers pass nothing.
 */
export interface LoadMemoriesDeps {
  /** Override config loader. Defaults to {@link loadMemoryConfig}. */
  loadConfig?: () => MemoryConfig
  /**
   * Override the summary-refresh implementation. Defaults to the real
   * one (which may call the LLM). Tests pass a fake to avoid network IO.
   */
  refresh?: typeof refreshAndRender
}

/**
 * Render the system-prompt fragment for the memory plugin.
 *
 * Dispatches through {@link STRATEGIES} based on the resolved
 * {@link MemoryConfig.inject} value. Returns `""` when nothing should
 * be injected, which causes the loader to drop the fragment entirely.
 */
export default async function loadMemories(
  ctx: PromptFragmentContext,
  deps: LoadMemoriesDeps = {},
): Promise<string> {
  const cfg = (deps.loadConfig ?? loadMemoryConfig)()
  const refresh = deps.refresh ?? refreshAndRender
  const strategy = STRATEGIES[cfg.inject]

  // Fast path: "none" emits nothing. Skip both file reads.
  if (cfg.inject === "none") return ""

  const gPath = globalMemoryPath()
  const pPath = projectMemoryPath(ctx.cwd)

  const globalSection = await strategy({
    label: "Global",
    memoryPath: gPath,
    scope: "global",
    cfg,
    refresh,
  })
  const projectSection = await strategy({
    label: "Project",
    memoryPath: pPath,
    scope: "project",
    cfg,
    refresh,
  })

  if (globalSection.length === 0 && projectSection.length === 0) return ""

  return composeFragment(cfg.inject, globalSection, projectSection)
}

/**
 * Glue the per-scope sections together under the `## Saved memories`
 * header with the appropriate framing for the inject mode.
 *
 * Kept private and small: the framing prose is intentionally minimal
 * because PROMPT.md (loaded separately, always) is the canonical place
 * for "how to use the tool". The framing here just disambiguates what
 * is in the block.
 */
function composeFragment(
  mode: MemoryInjectMode,
  globalSection: string[],
  projectSection: string[],
): string {
  const out: string[] = ["## Saved memories", ""]
  if (mode === "summary") {
    out.push(
      "Below the section headers, content is a CONDENSED summary",
      "(with `Sources: #id1, #id2` citing the underlying bullets).",
      "For the full body of any bullet referenced by id, call",
      '`MemoryTool({action: "read", scope, id})`. Bullets added since the',
      'last regen are listed verbatim under "Recent saves".',
      "",
    )
  } else {
    out.push(
      "Standing instructions and lessons-learned, persisted across sessions.",
      "Snapshot taken at session start: for the live state mid-session,",
      'call `MemoryTool({action: "list", scope: ...})`. Other agents in',
      "shared worktrees, CLI edits, and your own later saves all bypass",
      "this snapshot.",
      "",
    )
  }
  out.push(...globalSection)
  out.push(...projectSection)
  return out.join("\n")
}
