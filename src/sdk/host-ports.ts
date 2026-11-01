/**
 * Optional host ports for `AgentCore.run` (spec v2 section 2.6, S17).
 *
 * The host passes these ports when it builds the core. All four are optional.
 * With none, the loop runs headless:
 * - no `askUser`: an ask is denied with an `ask_denied` notice, and the
 *   request goes out unchanged;
 * - no `inputQueue`: no queued user text joins a request;
 * - no `reflectionGate`: a reflection checkpoint goes out with no pause;
 * - no `compactSource`: no plugin compact request runs between rounds.
 *
 * A per-run `askUser` option of `AgentCore.run` wraps the `askUser` port
 * through {@link runPorts}, and wins over the port the core was built with
 * for that run. The other ports have no per-run option: the host builds
 * them once and reads its own per-run state inside them.
 *
 * @module sdk/host-ports
 */

import type { AskUserFn } from "../agent/preflight-pipeline.ts"

import type { MaybePromise } from "./agent-core-helpers.ts"
import type { AskUserEvent } from "./events.ts"

/** One ask: the `ask_user` event payload without its `type` tag. */
export type AskUserRequest = Omit<AskUserEvent, "type">

/** Asks the user a question and waits for the answer. */
export interface AskUserPort {
  /**
   * Resolve with the id of the option the user chose, or `null` when the
   * user declines. The loop emits the `ask_user` event before it calls this.
   * `signal` aborts with the run.
   */
  ask(request: AskUserRequest, signal?: AbortSignal): Promise<string | null>
}

/** User text the host queued while a turn runs. */
export interface InputQueuePort {
  /**
   * Take the queued text, or `null` when nothing is queued. The loop calls
   * it between rounds, and when a `resume` run continues a paused turn.
   */
  take(): string | null
  /** The loop added `text` to the next request. */
  injected?(text: string): void
}

/** Pauses a turn for a host decision before a reflection checkpoint. */
export interface ReflectionGatePort {
  /** Resolves when the loop may send the reflection checkpoint for `round`. */
  beforeCheckpoint(round: number): MaybePromise<void>
}

/** A compact request a plugin queued. The loop drops unknown values. */
export interface PendingCompact {
  readonly reason?: string
  readonly mode?: string
  readonly keepTail?: number
  readonly focus?: string
}

/** Plugin compact requests. The loop takes one between rounds, never mid-round. */
export interface CompactSourcePort {
  /** Take the pending request, or `null` when none is queued. */
  take(): PendingCompact | null
}

/** The four optional host ports. */
export interface HostPorts {
  askUser?: AskUserPort
  inputQueue?: InputQueuePort
  reflectionGate?: ReflectionGatePort
  compactSource?: CompactSourcePort
}

/** The per-run options that override a built port for one run. */
export interface RunPortOverrides {
  askUser?: AskUserFn | undefined
}

/**
 * The ports for one run: the ports the core was built with, with a per-run
 * `askUser` wrapped as its port. A per-run `askUser` wins over the built port.
 */
export function runPorts(built: HostPorts, overrides: RunPortOverrides): HostPorts {
  const { askUser } = overrides
  const ports: HostPorts = { ...built }
  // The request carries every field of a preflight issue, so the per-run
  // function takes it as is.
  if (askUser) ports.askUser = { ask: (request) => askUser(request) }
  return ports
}

/**
 * Take queued host text from the input queue. Returns `null` when nothing
 * or only whitespace is queued.
 */
export function takeQueuedText(queue: InputQueuePort | undefined): string | null {
  const text = queue?.take() ?? null
  return text !== null && text.trim().length > 0 ? text : null
}
