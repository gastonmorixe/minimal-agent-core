/**
 * Drain a queued plugin compact request between rounds (S17, S27).
 *
 * A model-queued `CompactContext` is advisory: any compaction error (fork
 * stub, `compact.willRun` deny, a compaction already in progress, history
 * changed, a failed summary) keeps the history unchanged, emits the
 * `compact.pending_failed` diagnostic, and lets the turn continue. The
 * turn's abort signal is forwarded so a retrying local summary stops.
 *
 * @module sdk/drain-pending-compact
 */

import type { CompactRequestOpts, CompactStats } from "../agent/context-compact.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"

import { compactArgsFromPending } from "./agent-core-helpers.ts"
import type { HostPorts } from "./host-ports.ts"

/** The `errorKind` fact: the CoreError `kind`, else the Error `name`. */
export function compactErrorKind(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const kind = (error as { kind?: unknown }).kind
    if (typeof kind === "string" && kind.length > 0) return kind
    const name = (error as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0) return name
  }
  return typeof error
}

/**
 * Take one queued compact request from the host's `compactSource` port and
 * run it. A no-op when the host supplies no port or nothing is queued.
 * Never throws for a compaction error.
 */
export async function drainPendingCompact(
  ports: HostPorts,
  compact: (opts: CompactRequestOpts) => Promise<CompactStats>,
  diagnostics: Diagnostics,
  signal?: AbortSignal,
): Promise<void> {
  const pending = ports.compactSource?.take() ?? null
  if (pending === null) return
  const opts = compactArgsFromPending(pending)
  try {
    await compact({ ...opts, ...(signal ? { signal } : {}) })
  } catch (error) {
    diagnostics.warn("compact.pending_failed", "", {
      mode: opts.mode ?? "default",
      errorKind: compactErrorKind(error),
    })
  }
}
