/**
 * Replay renderer registry and its shared types.
 *
 * A plugin may declare a `replayRenderers` entry in its manifest. The
 * plugin loader resolves the handler module and registers it here. A
 * host replay path (the CLI's `session-replay-derivers.ts`) reads the
 * same registry through {@link getReplayRenderer}. One registry per
 * process, so the loader and the host always share it.
 *
 * Only the shared input shape lives in core. The derivers, the result
 * shape, and the replay render stay in the host.
 *
 * @module plugins/loader/replay-renderer-registry
 */

/**
 * The value a replay renderer returns. Core does not read it (spec S29):
 * its shape is a contract between a plugin and the host replay path,
 * which checks every field before it uses one.
 */
export type ReplayRenderResult = unknown

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
 * the host replay deriver is called with for a single historical
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
 * A plugin-supplied replay renderer for one tool name. Returns the host
 * view of the row, or `undefined` to decline (the host fallback then
 * runs). Must be synchronous — replay derivation is a pure pass over the
 * loaded records.
 */
export type ReplayToolRenderer = (ctx: ReplayToolRenderInput) => ReplayRenderResult

/**
 * Registered renderers, keyed by tool name. Module-level by design:
 * the loader registers at boot (before any replay runs) and the
 * registry is read by the host replay derivers without the
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

/** The registered replay renderer for `toolName`, if any. */
export function getReplayRenderer(toolName: string): ReplayToolRenderer | undefined {
  return replayRenderers.get(toolName)
}
