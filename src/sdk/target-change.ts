/**
 * What one change of the live target does, for every setter of
 * {@link AgentCore} (`switchTarget`, `setModel`, `setEffort`) and for the
 * automatic model adoption. Split out of `agent-core.ts` so that file stays
 * under the 810-line gate.
 *
 * A target is the credential/provider/model/effort quadruple. After a change:
 *
 * 1. The target version goes up. The loop compares it before each attempt
 *    and builds the system prompt again for the new target.
 * 2. A retry or quota wait in progress ends, and the next attempt starts
 *    with the new target. The turn is not aborted.
 * 3. Each listener gets the change (`from`, `to`).
 * 4. Thinking from before the change is discarded from the live history
 *    (a user-requested change only, see {@link discardThinking}), and the
 *    session log gets one record with the new target. This step never runs
 *    while a request is in flight: a request that streams keeps its target
 *    and its history. It runs at once when no run is active, else before
 *    the next attempt ({@link TargetChange.settle}).
 *
 * @module sdk/target-change
 */

import type { ContentBlock, Message } from "../llm/messages.ts"

import type { TargetState, TargetSwitch } from "./target-switch.ts"

/** Called after each change of the live target. */
export type TargetChangeListener = (change: TargetSwitch) => void

/** What the session log keeps for one change: the new target. */
export interface TargetSwitchEntry extends TargetState {
  /** True when thinking from before this change was discarded. */
  discardedThinking: boolean
}

/** Abort reason of a wait that a target change ended. Not a turn abort. */
export const TARGET_CHANGED = Object.freeze({ name: "TargetChanged" })

/** One retry or quota wait that a target change can end. */
export interface TargetWait {
  /** Fires on a turn abort or on a target change. Pass it to the wait. */
  readonly signal: AbortSignal
  /** True when a target change ended the wait (and the turn did not abort). */
  woke(): boolean
  /** The wait is over. Always call it. */
  done(): void
}

const isThinking = (b: ContentBlock): boolean =>
  b.type === "thinking" || b.type === "redacted_thinking"

/** The blocks of `blocks` that are not thinking. The same array when it has none. */
export function withoutThinking(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.some(isThinking) ? blocks.filter((b) => !isThinking(b)) : blocks
}

const asBlocks = (content: Message["content"]): ContentBlock[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content

/**
 * Remove each `thinking` and `redacted_thinking` block from the assistant
 * messages of `messages`, in place. Text, tool calls and tool results stay.
 * An assistant message that had only thinking is removed, so no empty
 * message is sent. When that leaves two user messages together, they become
 * one (the roles must alternate).
 *
 * A thinking block belongs to the target that made it: it can be signed for
 * one model, encrypted, or bound to one account. A different target cannot
 * read it and can reject the request. So a change of target discards it.
 *
 * @returns The number of blocks removed.
 */
export function discardThinking(messages: Message[]): number {
  let removed = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== "assistant" || typeof message.content === "string") continue
    const kept = withoutThinking(message.content)
    if (kept === message.content) continue
    removed += message.content.length - kept.length
    if (kept.length > 0) {
      messages[i] = { ...message, content: kept }
      continue
    }
    messages.splice(i, 1)
    const before = messages[i - 1]
    const after = messages[i]
    if (before?.role === "user" && after?.role === "user") {
      const content = [...asBlocks(before.content), ...asBlocks(after.content)]
      messages.splice(i - 1, 2, { ...before, content })
    }
  }
  return removed
}

/**
 * The change of an automatic model adoption (the preflight `adoptModelId`
 * path): the same credential and provider, a new model, and its effort.
 * `null` when nothing changed.
 */
export function adoptionChange(
  from: TargetState,
  model: string,
  effort: string | undefined,
): TargetSwitch | null {
  if (model === from.model && effort === from.effort) return null
  const effortReset = from.effort !== undefined && effort === undefined
  return {
    from,
    to: { ...from, model, effort },
    effortReset,
    effortFrom: effortReset ? from.effort : undefined,
  }
}

/** What a {@link TargetChange} needs from its core. */
export interface TargetChangeHost {
  /** Append the change to the session log. */
  persist(entry: TargetSwitchEntry): void
  /** Report a listener that threw. It never fails the change. */
  listenerFailed(err: unknown): void
}

/** The target-change state of one core. See the module doc. */
export class TargetChange {
  /** Goes up by one on each change of the live target. */
  version = 0
  /** True while a run is active. The core sets it. */
  running = false
  private readonly listeners = new Set<TargetChangeListener>()
  private wake: AbortController | null = null
  /** The newest target that {@link settle} did not handle yet. */
  private pending: TargetSwitchEntry | null = null

  constructor(private readonly host: TargetChangeHost) {}

  /** Subscribe to target changes. Returns the unsubscribe function. */
  on(listener: TargetChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Record one change that the core already assigned. `messages` is the live
   * history: with no run active it is settled now, else before the next
   * attempt.
   */
  apply(change: TargetSwitch, discardThinking: boolean, messages: Message[]): void {
    this.version++
    const discard = discardThinking || this.pending?.discardedThinking === true
    this.pending = { ...change.to, discardedThinking: discard }
    this.wake?.abort(TARGET_CHANGED)
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch (err) {
        this.host.listenerFailed(err)
      }
    }
    if (!this.running) this.settle(messages)
  }

  /**
   * Finish the pending change: discard the old thinking from `messages` (when
   * the change asked for it), then append the session record. Call it only
   * where no request is in flight, so the record comes after the response of
   * the last request of the old target.
   */
  settle(messages: Message[]): void {
    const entry = this.pending
    if (!entry) return
    this.pending = null
    if (entry.discardedThinking) discardThinking(messages)
    this.host.persist(entry)
  }

  /** Start one wait. `turnSignal` is the abort signal of the turn, if any. */
  wait(turnSignal: AbortSignal | undefined): TargetWait {
    const wake = new AbortController()
    this.wake = wake
    return {
      signal: turnSignal ? AbortSignal.any([turnSignal, wake.signal]) : wake.signal,
      woke: () => wake.signal.aborted && !turnSignal?.aborted,
      done: () => {
        if (this.wake === wake) this.wake = null
      },
    }
  }
}
