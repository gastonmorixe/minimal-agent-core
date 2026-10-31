/**
 * Headless default host ports for `createRuntime`'s sessions (spec v2
 * section 2.6, S47).
 *
 * `inputQueue`, `reflectionGate`, and `compactSource` default to the plain
 * no-ops `AgentCore` already falls back to when a host supplies no port at
 * all (host-ports.ts). `askUser` is different: a real pending-promise
 * implementation, {@link PendingAskRegistry}, so `session.answer` has
 * something to resolve. Without it, `session.answer` would never do
 * anything for a session that did not bring its own `askUser` port.
 *
 * @module runtime/host-ports-defaults
 */

import type {
  AskUserPort,
  AskUserRequest,
  CompactSourcePort,
  InputQueuePort,
  ReflectionGatePort,
} from "../sdk/host-ports.ts"

/** No queued user text, ever. */
export const NOOP_INPUT_QUEUE: InputQueuePort = { take: () => null }

/** Never pauses a reflection checkpoint. */
export const NOOP_REFLECTION_GATE: ReflectionGatePort = { beforeCheckpoint: () => {} }

/** No plugin compact request is ever pending. */
export const NOOP_COMPACT_SOURCE: CompactSourcePort = { take: () => null }

/**
 * An `askUser` port backed by a pending-promise map keyed by `askId`. The
 * loop's `ask()` call resolves once {@link PendingAskRegistry.answer} is
 * called with the same id, or once its `signal` aborts (the answer is then
 * `null`, same as a user decline). Built once per session by
 * `runtime/session.ts`; `session.answer` calls {@link answer} on it.
 */
export class PendingAskRegistry implements AskUserPort {
  private readonly pending = new Map<string, (answer: string | null) => void>()

  /** Resolve with the chosen option id once {@link answer} is called. */
  ask(request: AskUserRequest, signal?: AbortSignal): Promise<string | null> {
    const { askId } = request
    return new Promise((resolve) => {
      const settle = (value: string | null): void => {
        if (this.pending.delete(askId)) resolve(value)
      }
      this.pending.set(askId, settle)
      signal?.addEventListener("abort", () => settle(null), { once: true })
    })
  }

  /**
   * Resolve the pending ask `askId` with `answer`. Returns `false` when no
   * ask with that id is pending (already answered, never asked, or a
   * caller-supplied `askUser` port handled it instead of this registry).
   */
  answer(askId: string, answer: string | null): boolean {
    const settle = this.pending.get(askId)
    if (!settle) return false
    settle(answer)
    return true
  }

  /** Decline every still-pending ask. Called when its session closes. */
  declineAll(): void {
    for (const askId of [...this.pending.keys()]) this.answer(askId, null)
  }
}
