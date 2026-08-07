/**
 * Replay re-derivers : recover the `display` / `displayHeader` /
 * `displayFooter` fields the live transcript drew for a tool call, when
 * the session JSONL was written BEFORE those fields were persisted (or
 * by a tool that doesn't supply them).
 *
 * Two layers, plugin first:
 *
 *   1. **Loader-registered replay renderers (the seam).** A plugin may
 *      declare a `replayRenderers` entry in its manifest; the loader
 *      resolves the handler module through its blessed dynamic-import
 *      seam and registers it here via {@link registerReplayRenderer}.
 *      At replay time {@link deriveDisplayFallback} gives the
 *      registered renderer first crack at the row. The tasks plugin
 *      uses this to re-render historical `Task` calls with full ANSI
 *      styling from the per-session sidecar. A renderer that returns
 *      `undefined` (or throws) falls through to layer 2 — a buggy or
 *      absent plugin never breaks `--resume`.
 *
 *   2. **Core-local fallbacks.** Pure functions with no plugin
 *      dependency:
 *
 *      - **Task** — split `content` at the first / last lines and treat
 *        the middle as the body (the Task plugin's `content` is built
 *        by joining the same `displayParts`, so the split recovers the
 *        plain-text tree shape, minus ANSI styling).
 *      - **Edit** — synthesize a unified diff from `old_string` /
 *        `new_string` and colorize through the core-local
 *        {@link renderUnifiedDiff}, so the pink/lime hunk styling
 *        matches the live tool.
 *      - **Write** — same idea with `before=""`, so the whole input
 *        renders as `+`-prefixed addition lines.
 *
 * Each re-deriver is a pure function `(input, content) -> overrides?`.
 * The return shape mirrors `ToolResultRecord`'s presentation fields.
 * `undefined` means "no override produced, fall back to the default
 * content rendering" — never "throw".
 *
 * @module session-replay-derivers
 */

import { buildEditDiff, buildFileDiff } from "../utils/diff.ts"

import { renderUnifiedDiff } from "./ui/render/unified-diff.ts"

/**
 * Override fields a re-deriver may populate. Each one is independently
 * optional : a deriver that only knows the body returns
 * `{ display: "..." }` and leaves header/footer untouched.
 */
export interface DerivedDisplay {
  display?: string
  displayHeader?: string
  displayFooter?: string
}

/**
 * Structural slice of the tasks plugin's per-session sidecar row
 * (`<sid>.tasks.jsonl`). Re-declared core-locally so the replay path
 * carries sidecar data WITHOUT importing the plugins tree (the I2
 * invariant); the plugin's own `Task` shape is assignable to this by
 * structural typing, and the plugin-registered replay renderer is the
 * only consumer that interprets it.
 */
export interface ReplaySidecarTask {
  /** Ordinal or legacy six-hex root id, optionally plus an alpha child suffix. No `#`. */
  id: string
  /** Root task id (ordinal or legacy six-hex, no `#`), or `null` for top-level tasks. */
  parent: string | null
  /** Lifecycle state. */
  status: "todo" | "doing" | "done" | "canceled"
  /** Free-text title. */
  title: string
  /** ISO 8601 creation timestamp. */
  created_at: string
  /** ISO 8601 timestamp when status flipped to `done`, else `null`. */
  done_at: string | null
  /** Optional reason recorded with a `canceled` status. */
  reason: string | null
  /** ISO 8601 timestamp of the first `*→doing` transition, else `null`. */
  started_at: string | null
  /** ISO 8601 timestamp of the most recent `*→doing` transition, else `null`. */
  last_resumed_at: string | null
  /** Total accumulated time-in-`doing` (milliseconds). */
  active_ms: number
}

/**
 * The row data a registered replay renderer receives. Mirrors what
 * {@link deriveDisplayFallback} is called with for a single historical
 * `tool_result` row (errors are filtered out before renderers run).
 */
export interface ReplayToolRenderInput {
  /** The tool_use's `input` object as the model supplied it. */
  input: Record<string, unknown>
  /** The model-facing `tool_result.content` text. */
  content: string
  /** Wall-clock at the moment the historical call ran, when known. */
  callTs: Date | null
  /** Parsed sidecar task list, when the caller loaded one. */
  sidecarTasks: readonly ReplaySidecarTask[] | null
}

/**
 * A plugin-supplied replay renderer for one tool name. Returns the
 * presentation overrides for the row, or `undefined` to decline (the
 * core fallback then runs). Must be synchronous — replay derivation is
 * a pure pass over the loaded records.
 */
export type ReplayToolRenderer = (ctx: ReplayToolRenderInput) => DerivedDisplay | undefined

/**
 * Registered renderers, keyed by tool name. Module-level by design:
 * the loader registers at boot (before any replay runs) and the
 * registry is consulted by {@link deriveDisplayFallback} without the
 * replay call sites having to thread a loader handle through.
 */
const replayRenderers = new Map<string, ReplayToolRenderer>()

/**
 * Register a replay renderer for `toolName`. A second registration for
 * the same tool replaces the first (loader precedence already settled
 * which plugin wins before this is called). Returns an unregister
 * handle that removes the renderer only if it is still the active one.
 */
export function registerReplayRenderer(toolName: string, fn: ReplayToolRenderer): () => void {
  replayRenderers.set(toolName, fn)
  return () => {
    if (replayRenderers.get(toolName) === fn) replayRenderers.delete(toolName)
  }
}

/** Drop every registered replay renderer. Test hygiene helper. */
export function clearReplayRenderers(): void {
  replayRenderers.clear()
}

/**
 * Annotation prefixes the agent appends to `content` for the model.
 * Stripped before splitting Task content so the trailing
 * `<ma::agent::output-preview …>…</ma::agent::output-preview>` and
 * `<ma::tui-preview …>…</ma::tui-preview>` blocks don't bleed into
 * the derived header/body/footer.
 *
 * Mirrors `findAnnotationStart` in `src/ui/tool-transcript/format.ts`. Kept
 * local here to avoid the import-cycle risk (replay → agent → replay).
 */
const ANNOTATION_OPENERS: readonly string[] = [
  "\n\n[truncated:",
  "\n\n[note:",
  "\n\n<ma::agent::output-preview",
  "\n\n<ma::tui-preview",
]

function stripTrailingAnnotations(content: string): string {
  let earliest = -1
  for (const op of ANNOTATION_OPENERS) {
    const i = content.lastIndexOf(op)
    if (i !== -1 && (earliest === -1 || i < earliest)) earliest = i
  }
  return earliest === -1 ? content : content.slice(0, earliest)
}

/**
 * The Task plugin's `content` text is always `header\nbody\nfooter` (or
 * subsets when one of the parts is empty). Split it back into the three
 * presentation slots. Empty results return `undefined` so the caller
 * can fall through to the default rendering path.
 *
 * Heuristic: when content has ≥ 3 non-empty lines, line 0 is header,
 * line N-1 is footer, the rest is the body. With 2 lines we treat them
 * as header + body. With 1 line we surface it as the header. Zero
 * lines → no override.
 *
 * The body slot keeps any blank lines from the middle (the task plugin
 * uses a blank line between top-level tasks and the subtree). Trailing
 * whitespace on each line is preserved verbatim so the alignment the
 * user saw live stays intact.
 *
 * This is the CORE fallback: plain text only. The ANSI-colored
 * re-render (per-call status snapshots from the sidecar) lives in the
 * tasks plugin's `replayRenderers` handler and reaches replay through
 * {@link registerReplayRenderer}.
 */
export function deriveTaskDisplay(opts: { content: string }): DerivedDisplay | undefined {
  const trimmed = stripTrailingAnnotations(opts.content).replace(/\n+$/g, "")
  if (trimmed.length === 0) return undefined
  const lines = trimmed.split("\n")
  if (lines.length === 1) return { displayHeader: lines[0] }
  if (lines.length === 2) return { displayHeader: lines[0], display: lines[1] }
  const header = lines[0]
  const footer = lines[lines.length - 1]
  const bodyLines = lines.slice(1, -1)
  return { displayHeader: header, display: bodyLines.join("\n"), displayFooter: footer }
}

/**
 * Synthesize a unified diff for an `Edit` tool call from its persisted
 * input. We don't have the file's BEFORE content (the file likely
 * changed many edits later), so we use `old_string` itself as `before`
 * and run the same `buildEditDiff` the live tool uses. The hunk has
 * no surrounding context (it would be the same `-`/`+` lines anyway)
 * but the structural diff is faithful : `-` for every old line, `+`
 * for every new line, with hunk markers and `--- a/…` / `+++ b/…`
 * headers ready for `renderUnifiedDiff` to color.
 *
 * Returns `undefined` when `old_string` / `new_string` are missing or
 * empty : we'd produce a contentless diff in that case and the live
 * tool wouldn't have either.
 */
export function deriveEditDisplay(input: Record<string, unknown>): DerivedDisplay | undefined {
  const filePath = typeof input.file_path === "string" ? input.file_path : null
  const oldString = typeof input.old_string === "string" ? input.old_string : null
  const newString = typeof input.new_string === "string" ? input.new_string : null
  const replaceAll = input.replace_all === true
  if (filePath === null || oldString === null || newString === null) return undefined
  if (oldString.length === 0) return undefined
  // No-context diff: pass before=oldString so the diff machinery finds
  // the match at offset 0 and emits the `-old / +new` hunk without
  // surrounding context. Loses the contextual ribbon lines (` ` rows)
  // the live diff has, which is acceptable : the user mainly cares
  // about WHAT changed, and that's preserved verbatim.
  const patch = buildEditDiff(filePath, oldString, oldString, newString, replaceAll, 0)
  if (patch === "") return undefined
  const display = renderUnifiedDiff(patch)
  return { display }
}

/**
 * Synthesize a "new file" diff for a `Write` tool call from its
 * persisted input. The live tool computes the diff between the file's
 * pre-write content and the new content; at replay time the file's
 * pre-write content is unknowable, so we render the WHOLE input as
 * additions (i.e. treat it as a brand-new file).
 *
 * Visually this differs from the live render when the Write actually
 * modified an existing file : pre-fix sessions show "+" for every
 * line of the new content instead of a focused hunk on the edited
 * region. The structural information is still faithful (the user can
 * see the file's final state in green) and there's no false-negative
 * (we don't omit anything that did change).
 */
export function deriveWriteDisplay(input: Record<string, unknown>): DerivedDisplay | undefined {
  const filePath = typeof input.file_path === "string" ? input.file_path : null
  const contentArg = typeof input.content === "string" ? input.content : null
  if (filePath === null || contentArg === null) return undefined
  if (contentArg.length === 0) return undefined
  const patch = buildFileDiff(filePath, "", contentArg, 0)
  if (patch === "") return undefined
  const display = renderUnifiedDiff(patch, `New file: ${filePath}`)
  return { display }
}

/**
 * Validate and narrow a renderer's return value. Plugins are untrusted
 * here: anything that isn't a plain object with string presentation
 * fields is treated as "declined" so the core fallback still runs.
 */
function sanitizeRendererResult(result: unknown): DerivedDisplay | undefined {
  if (typeof result !== "object" || result === null) return undefined
  const r = result as Record<string, unknown>
  const out: DerivedDisplay = {}
  if (typeof r.display === "string") out.display = r.display
  if (typeof r.displayHeader === "string") out.displayHeader = r.displayHeader
  if (typeof r.displayFooter === "string") out.displayFooter = r.displayFooter
  if (
    out.display === undefined &&
    out.displayHeader === undefined &&
    out.displayFooter === undefined
  ) {
    return undefined
  }
  return out
}

/**
 * Tool-name → re-deriver dispatch. Used by `toolDisplaysFromRecords`
 * in `src/session-replay.ts` when the persisted `tool_result` row has
 * no `display` / `displayHeader` / `displayFooter` of its own.
 *
 * Resolution order per row:
 *
 *   1. A loader-registered plugin renderer for the tool name (the
 *      seam). Errors and `undefined` fall through.
 *   2. The core-local fallback for Task / Edit / Write.
 *   3. `undefined` — the row renders its model-facing `content`.
 *
 * Errors inside any layer are swallowed (returns undefined) so a buggy
 * renderer never breaks the resume path : the worst case is "this tool
 * row falls back to the unconditional content render".
 */
export function deriveDisplayFallback(opts: {
  toolName: string
  input: Record<string, unknown> | undefined
  content: string
  isError: boolean
  /**
   * Wall-clock at the moment the historical call ran. Forwarded to
   * registered plugin renderers (the tasks plugin uses it for
   * cutoff-based status reconstruction). Core fallbacks ignore it.
   */
  callTs?: Date | null
  /**
   * Sidecar task list (already parsed). Forwarded to registered plugin
   * renderers for ANSI-colored re-rendering. When omitted / empty, the
   * core Task fallback's content-split path still works (plain text).
   */
  sidecarTasks?: readonly ReplaySidecarTask[] | null
}): DerivedDisplay | undefined {
  if (opts.isError) return undefined
  const input = opts.input ?? {}

  // Layer 1: plugin-registered renderer (the loader-resolved seam).
  const renderer = replayRenderers.get(opts.toolName)
  if (renderer !== undefined) {
    try {
      const result = sanitizeRendererResult(
        renderer({
          input,
          content: opts.content,
          callTs: opts.callTs ?? null,
          sidecarTasks: opts.sidecarTasks ?? null,
        }),
      )
      if (result !== undefined) return result
    } catch {
      // Fall through to the core fallback below.
    }
  }

  // Layer 2: core-local fallbacks.
  try {
    switch (opts.toolName) {
      case "Task":
        return deriveTaskDisplay({ content: opts.content })
      case "Edit":
        return deriveEditDisplay(input)
      case "Write":
        return deriveWriteDisplay(input)
      default:
        return undefined
    }
  } catch {
    return undefined
  }
}
