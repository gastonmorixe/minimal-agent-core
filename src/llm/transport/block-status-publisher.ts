/**
 * Publish stream block facts on a live status.
 *
 * Bridges the watchdog's {@link WatchdogOptions.onBlockState} feed to
 * {@link LiveStatus.updateActivity}: phase, tool name and idle-budget
 * changes go out at once; `lastContentAt`-only moves (every content delta)
 * are throttled, the same way the byte counter in `network/activity-observer.ts`
 * is, so a fast text stream does not repaint the host once per token.
 *
 * Data only. A host turns these facts into labels and "stalled" verdicts.
 *
 * @module llm/transport/block-status-publisher
 */

import type { LiveStatus } from "../../bus/status-port.ts"

import type { StreamBlockState } from "./stream-block-tracker.ts"
import type { WatchdogOptions } from "./watchdog.ts"

/** Default minimum gap between `lastContentAt`-only publishes. */
export const BLOCK_STATUS_THROTTLE_MS = 100

export interface BlockStatusPublisher {
  /** Pass as the watchdog's `onBlockState`. */
  readonly onBlockState: NonNullable<WatchdogOptions["onBlockState"]>
  /**
   * A new attempt is starting: reset to `connect` (no response yet) so a
   * retry never keeps showing the previous attempt's `thinking`.
   */
  attemptStarted(): void
}

/**
 * Overrides for {@link createBlockStatusPublisher}, so tests can drive the
 * clock and the throttle without waiting on real time.
 */
type BlockStatusPublisherOpts = {
  /** Clock used for throttle windows. Defaults to `Date.now`. */
  now?: () => number
  /** Minimum gap between publishes. Defaults to {@link BLOCK_STATUS_THROTTLE_MS}. */
  throttleMs?: number
}

/**
 * Make a publisher for one send.
 *
 * @param live - The send's live status.
 * @param opts - Clock and throttle overrides (tests).
 */
export function createBlockStatusPublisher(
  live: Pick<LiveStatus, "updateActivity">,
  opts: BlockStatusPublisherOpts = {},
): BlockStatusPublisher {
  const now = opts.now ?? Date.now
  const throttleMs = opts.throttleMs ?? BLOCK_STATUS_THROTTLE_MS
  let lastPublish = Number.NEGATIVE_INFINITY
  let lastBudget: number | undefined

  const publish = (state: StreamBlockState & { idleBudgetMs: number }): void => {
    lastPublish = now()
    lastBudget = state.idleBudgetMs
    live.updateActivity({
      ...(state.phase ? { phase: state.phase } : {}),
      ...(state.phaseStartedAt !== undefined ? { phaseStartedAt: state.phaseStartedAt } : {}),
      ...(state.lastContentAt !== undefined ? { lastContentAt: state.lastContentAt } : {}),
      idleBudgetMs: state.idleBudgetMs,
      toolName: state.toolName ?? null,
    })
  }

  return {
    onBlockState: (state, changed) => {
      if (changed || state.idleBudgetMs !== lastBudget || now() - lastPublish >= throttleMs) {
        publish(state)
      }
    },
    attemptStarted: () => {
      lastPublish = Number.NEGATIVE_INFINITY
      lastBudget = undefined
      live.updateActivity({ phase: "connect", phaseStartedAt: now(), toolName: null })
    },
  }
}
