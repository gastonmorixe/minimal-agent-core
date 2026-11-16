/**
 * Lifecycle deny error (spec R-ERR-CLS-9). It holds facts and no text: a
 * host renders it.
 *
 * @module errors/lifecycle
 */

import { CoreError } from "./core-error.ts"

/** The lifecycle hooks whose deny core throws as a {@link LifecycleDeniedError}. */
export type LifecycleDeniedHook =
  | "turn.willStart"
  | "message.willSend"
  | "tool.willInvoke"
  | "tool.didBatch"
  | "compact.willRun"
  | "subagent.willSpawn"

/**
 * The facts of a failed approval (`failClosed`) listener: the listener label,
 * when known, and the error text of the failure.
 */
export interface LifecycleHookFailure {
  readonly label?: string
  readonly detail: string
}

/** The fields of a {@link LifecycleDeniedError}. Only `hook` is required. */
export interface LifecycleDeniedFacts {
  /** The hook (channel) that denied. */
  readonly hook: LifecycleDeniedHook
  /** The deny reason the plugin gave. Core never writes it. Absent or "" when none. */
  readonly reason?: string
  /** The plugin id of the listener that halted, when known. */
  readonly pluginId?: string
  /** The tool name, for a deny about one tool. */
  readonly tool?: string
  /** Set when an approval listener failed (threw, timed out, gave a bad result). */
  readonly failure?: LifecycleHookFailure
  /** Hook context lines of the deny, for a caller that uses them. */
  readonly additionalContext?: readonly string[]
}

/**
 * A lifecycle hook denied an operation (a send, a compaction, the next tool
 * round). The deny is the class itself: `reason` is optional data, so a deny
 * with no reason is still a deny.
 */
export class LifecycleDeniedError extends CoreError {
  static readonly kind = "LifecycleDeniedError"
  declare readonly kind: "LifecycleDeniedError"
  readonly hook: LifecycleDeniedHook
  readonly reason?: string
  readonly pluginId?: string
  readonly tool?: string
  readonly failure?: LifecycleHookFailure
  readonly additionalContext: readonly string[]

  constructor(facts: LifecycleDeniedFacts, options?: { cause?: unknown }) {
    super(options)
    this.hook = facts.hook
    if (facts.reason !== undefined) this.reason = facts.reason
    if (facts.pluginId !== undefined) this.pluginId = facts.pluginId
    if (facts.tool !== undefined) this.tool = facts.tool
    if (facts.failure !== undefined) this.failure = { ...facts.failure }
    this.additionalContext = Object.freeze([...(facts.additionalContext ?? [])])
  }
}
