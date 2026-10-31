/**
 * The live status port (spec S23): what the engine reports while it sends a
 * request, runs a tool, or waits. Phase codes and numbers only. The engine
 * writes no label and no spinner theme; the host maps each phase to its own
 * text (the CLI mirrors it onto its status bus).
 *
 * Each `open` and `update` is also a `status` event on the run's event
 * stream. The live numbers (`updateActivity`) are not events: they change
 * many times a second, and the host reads them at its own pace.
 *
 * @module bus/status-port
 */

import type { StatusActivity } from "./status.ts"

/**
 * What the loop is doing or waiting on.
 *
 * - `sending`: a model request is on its way; no response yet.
 * - `receiving`: the model response is streaming in.
 * - `running_tool`: the loop runs the tool `toolName`.
 * - `retrying`: a transient error; the next attempt starts after `nextDelayMs`.
 * - `waiting_for_quota`: the provider quota resets at `resetAt` (epoch ms).
 * - `waiting_for_host`: a permanent error paused the run; the host resumes it
 *   with the next run.
 */
export type StatusPhase =
  | "sending"
  | "receiving"
  | "running_tool"
  | "retrying"
  | "waiting_for_quota"
  | "waiting_for_host"

/** The fields of one status: a phase code plus numbers and codes, no label. */
export interface StatusFields {
  phase: StatusPhase
  /** The tool that runs (`running_tool`). */
  toolName?: string
  /** Number of the attempt that starts after the wait. */
  attempt?: number
  /** Wait before that attempt, in ms. */
  nextDelayMs?: number
  /** Quota reset time, epoch ms (`waiting_for_quota`). */
  resetAt?: number
  /** Short cause code: the error's retry tag, or its class. */
  cause?: string
}

/** One open activity: a request, a tool call, or a wait. */
export interface LiveStatus {
  /** Move the activity to a new phase. */
  update(fields: StatusFields): void
  /** Patch the live numbers (bytes, tokens, timestamps). */
  updateActivity(activity: StatusActivity): void
  /** The activity ended. */
  clear(): void
}

/** Opens live statuses. The host supplies one; the engine never reads a global. */
export interface StatusPort {
  open(fields: StatusFields): LiveStatus
}

/** A live status that goes nowhere. */
export const NOOP_LIVE_STATUS: LiveStatus = {
  update: () => {},
  updateActivity: () => {},
  clear: () => {},
}

/** A status port that goes nowhere (no host status display). */
export const NOOP_STATUS_PORT: StatusPort = { open: () => NOOP_LIVE_STATUS }
