/**
 * Hook system public types.
 *
 * Two complementary surfaces ride the same author-facing API:
 *
 * - **Lifecycle events** are observation-only ("X happened"). They use the
 *   `broadcast-async` shape and ride the existing {@link EventBus}.
 * - **Hooks** are extension points that can transform payloads or veto
 *   actions ("about to do X — anyone want to change X?"). They use the
 *   `chain`, `broadcast-sync`, or `stream` shape and ride {@link HookBus}.
 *
 * Plugin authors don't need to know which bus a channel rides — the
 * {@link Hooks} facade routes by the channel's declared shape.
 *
 * See `TODO-hooks.md` for the full architecture rationale.
 *
 * @module plugins/hooks/types
 */

/** Delivery semantics of a channel. */
export type ChannelShape = "broadcast-sync" | "broadcast-async" | "chain" | "stream"

/**
 * Result a `chain` listener returns. `void` (or `undefined`) means
 * pass-through. Returning `{payload}` replaces the threaded payload.
 * Returning `{halt: true}` short-circuits the chain — subsequent
 * listeners are skipped and the bus reports who halted.
 */
export type ChainResult<T> =
  | void
  | { payload: T }
  | { payload: T; halt: true }
  | { halt: true; reason?: string }

/** Function signature varies by shape. */
export type HookListener<T = unknown> =
  | SyncListener<T>
  | AsyncListener<T>
  | ChainListener<T>
  | StreamListener<T>

export type SyncListener<T> = (payload: T, ctx: HookCtx) => void
export type AsyncListener<T> = (payload: T, ctx: HookCtx) => void | Promise<void>
export type ChainListener<T> = (
  payload: T,
  ctx: HookCtx,
) => ChainResult<T> | Promise<ChainResult<T>>
export type StreamListener<T> = (stream: AsyncIterable<T>, ctx: HookCtx) => void | Promise<void>

/** Context passed as the second arg to every listener. */
export interface HookCtx {
  /** The channel name being dispatched. */
  readonly channel: string
  /** Aborts when the bus disposes (or per-call if propagated). */
  readonly abort: AbortSignal
  /** Diagnostic logger. */
  readonly logger: (msg: string) => void
  /** Plugin id of the listener (`"agent"` for internal). */
  readonly source: string
  /** Resolved priority used for ordering. */
  readonly priority: number
}

/** Options accepted by `Hooks.on` / `HookBus.on`. */
export interface ListenOpts {
  /**
   * Higher runs first. Plugin range is `[0..100]` (clamped). Agent
   * internals use `[1000..9999]`. Reserved/system ≥ `10000`. Defaults
   * to 50 for plugins, 5000 for agent.
   */
  priority?: number
  /** Source tag for debugging / unregister-by-source. */
  source?: string
  /** Diagnostic label (defaults to `${source}:${channel}`). */
  label?: string
  /**
   * For `chain`: declare the listener as observation-only. The bus may
   * skip clone overhead. A non-void return is logged as a warning.
   */
  observeOnly?: boolean
  /**
   * For `chain`: max ms a single listener may run before the bus skips
   * it and continues with the pre-call payload. Defaults: 2000 for
   * plugins, unbounded for agent.
   */
  timeoutMs?: number
}

/** Returned by `on(...)`. Removes the subscription. Idempotent. */
export type Disposer = () => void

/** Result of dispatching a `chain` channel. */
export interface ChainEmitResult<T> {
  payload: T
  halted: boolean
  haltedBy?: string
  reason?: string
}

/**
 * One channel declaration in the registry. Lives in one place so
 * runtime, types, docs, and permission checks all agree.
 */
export interface ChannelSpec<_T = unknown> {
  /** Channel name, dot-separated (`turn.didEnd`, `tool.willInvoke`). */
  name: string
  shape: ChannelShape
  /** Permission required to register a listener (e.g. `hooks:turn.didEnd`). */
  permission: string
  /** One-line human description. */
  description: string
}
