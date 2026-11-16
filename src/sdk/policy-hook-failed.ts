/**
 * The error a lifecycle port throws from `beforeTool` when a failClosed
 * (approval) listener failed. It carries the facts only: the tool round
 * turns them into the `tool_result.policy_hook_failed` text.
 *
 * @module sdk/policy-hook-failed
 */

/** The facts of a failed approval listener. */
export interface PolicyHookFailure {
  /** The failing listener label. */
  label: string
  /** The error text of the failure. */
  detail: string
}

/** A failClosed listener threw, timed out or gave a malformed result. */
export class PolicyHookFailedError extends Error {
  constructor(
    readonly label: string,
    readonly detail: string,
  ) {
    super(detail)
    this.name = "PolicyHookFailedError"
  }
}
