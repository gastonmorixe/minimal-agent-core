/**
 * Headless default host ports for `createRuntime`'s sessions (spec v2
 * section 2.6, S47).
 *
 * `inputQueue`, `reflectionGate`, and `compactSource` default to the plain
 * no-ops `AgentCore` already falls back to when a host supplies no port at
 * all (host-ports.ts). `askUser` is different: a real pending-promise
 * implementation, {@link PendingAskRegistry}, that a host opts in to
 * (`askUserFallback: "registry"`) when it answers asks through
 * `session.answer`. The registry always has a deadline (decision 11).
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

/** Options for {@link PendingAskRegistry}. */
export interface PendingAskRegistryOptions {
  /**
   * Time in ms that an ask stays pending. Then it resolves with the id of
   * its default option (`isDefault`), or `null` (a decline) when it has no
   * default option. Required: no human is assumed (decision 11), so an ask
   * must never wait forever. Must be a positive finite number.
   */
  deadlineMs: number
  /** Called once for each ask that the deadline resolves. */
  onDeadline?: (request: AskUserRequest, answer: string | null) => void
}

/**
 * An `askUser` port backed by a pending-promise map keyed by `askId`. The
 * loop's `ask()` call resolves once {@link PendingAskRegistry.answer} is
 * called with the same id, once its `signal` aborts (the answer is then
 * `null`, same as a user decline), or once the deadline ends (the answer is
 * then the default option, or `null`). Built once per session by
 * `runtime/session.ts` when the host opts in to the `"registry"`
 * fallback (`askUserFallback`). `session.answer` calls {@link answer} on it.
 */
export class PendingAskRegistry implements AskUserPort {
  private readonly pending = new Map<string, (answer: string | null) => boolean>()
  private readonly deadlineMs: number
  private readonly onDeadline: PendingAskRegistryOptions["onDeadline"]

  /**
   * Build an empty registry.
   *
   * @throws Error when `deadlineMs` is not a positive finite number
   */
  constructor(options: PendingAskRegistryOptions) {
    const { deadlineMs } = options
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new Error(`PendingAskRegistry: deadlineMs must be a positive number, got ${deadlineMs}`)
    }
    this.deadlineMs = deadlineMs
    this.onDeadline = options.onDeadline
  }

  /**
   * Resolve with the chosen option id once {@link answer} is called, or
   * with the default option id (or `null`) when the deadline ends first.
   */
  ask(request: AskUserRequest, signal?: AbortSignal): Promise<string | null> {
    const { askId } = request
    return new Promise((resolve) => {
      const deadline = AbortSignal.timeout(this.deadlineMs)
      const onDeadline = (): void => {
        const fallback = request.options.find((option) => option.isDefault)?.id ?? null
        if (settle(fallback)) this.onDeadline?.(request, fallback)
      }
      const settle = (value: string | null): boolean => {
        if (!this.pending.delete(askId)) return false
        deadline.removeEventListener("abort", onDeadline)
        resolve(value)
        return true
      }
      this.pending.set(askId, settle)
      deadline.addEventListener("abort", onDeadline, { once: true })
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
