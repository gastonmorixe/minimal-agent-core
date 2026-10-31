/**
 * Round checkpoints (spec v2 section 2.2, S50).
 *
 * A turn writes a checkpoint through the session persistence port when it
 * starts, after each completed round, and when it ends. A round is complete
 * when its response and the result of every tool call it made are in the
 * session log. After a crash or a restart, `loadSession(...).resume` (in
 * `src/session/session-restore.ts`) reads the last checkpoint of an
 * unfinished turn back with the history up to that round, and
 * `AgentCore.run(input, { resume: true })` continues the turn at the next
 * round.
 *
 * @module sdk/round-checkpoint
 */

import type { Streaks, TurnOutcome } from "./stop-policy.ts"

/** Where an unfinished turn stands. */
export interface RoundCheckpoint {
  /** Rounds the turn completed. The next round is `round + 1`. */
  round: number
  /** The D20 continuation streaks after that round. */
  streaks: Streaks
}

/** A checkpoint as the session log keeps it. */
export interface RoundCheckpointRecord extends RoundCheckpoint {
  /** How the turn ended. Absent while the turn runs. */
  outcome?: TurnOutcome
}

/** The checkpoint of a turn that has not completed a round yet. */
export const TURN_START: RoundCheckpoint = Object.freeze({
  round: 0,
  streaks: Object.freeze({ maxTokens: 0, interrupted: 0 }),
})

/**
 * True when a `resume` run can continue a turn that ended this way: the turn
 * has no outcome yet (a crash or a restart cut it), or it waits for the host
 * (stop-table row 11).
 */
export function isUnfinished(outcome: TurnOutcome | undefined): boolean {
  return outcome === undefined || outcome === "waiting"
}
