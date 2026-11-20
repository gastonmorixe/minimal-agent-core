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

import type { HookContextEntry } from "../../sdk/hook-context.ts"

export type { HookContextEntry }

/** Delivery semantics of a channel. */
export type ChannelShape = "broadcast-sync" | "broadcast-async" | "chain" | "stream"

/**
 * Result a `chain` listener returns. `void` (or `undefined`) means
 * pass-through. Returning `{payload}` replaces the threaded payload.
 * Returning `{halt: true}` short-circuits the chain — subsequent
 * listeners are skipped and the bus reports who halted.
 * `additionalContext` (alone or with the other fields) adds model-facing
 * context entries ({@link HookContextEntry}: a string, or `{ text, position }`).
 * The bus collects them as they are, in listener order. `position` counts
 * only on `turn.willStart` and `session.willStart`.
 */
export type ChainResult<T> =
  | void
  | { payload: T; additionalContext?: HookContextEntry[] }
  | { payload: T; halt: true; additionalContext?: HookContextEntry[] }
  | { halt: true; reason?: string; additionalContext?: HookContextEntry[] }
  | { additionalContext: HookContextEntry[] }

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
  /**
   * Aborts when the bus disposes, or when the caller signal of the dispatch
   * aborts ({@link ChainEmitOptions.signal}, for example the turn signal of
   * `turn.willStop`).
   */
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
   * it and continues with the pre-call payload. No timeout when omitted
   * (the loader passes the manifest value as is).
   */
  timeoutMs?: number
  /**
   * For `chain`: mark the listener as an approval gate. When it throws,
   * rejects, or exceeds `timeoutMs`, the chain halts (deny) with the `failure` facts.
   * Unflagged listeners that fail are skipped (pass-through). Use it only
   * for a hook whose job is to approve or deny, so that an unrelated buggy
   * hook cannot block all progress.
   */
  failClosed?: boolean
}

/** Returned by `on(...)`. Removes the subscription. Idempotent. */
export type Disposer = () => void

/** Options of one `chain` dispatch. */
export interface ChainEmitOptions {
  /**
   * The signal of the caller (for `turn.willStop`: the turn signal). Each
   * listener gets it in `ctx.abort`, merged with the bus dispose signal.
   * When it aborts, the bus stops to wait for the running listener, clears
   * its timeout timer and runs no more listeners. The result then has no
   * halt: the caller reads its own signal.
   */
  readonly signal?: AbortSignal
}

/** Result of dispatching a `chain` channel. */
export interface ChainEmitResult<T> {
  payload: T
  halted: boolean
  haltedBy?: string
  reason?: string
  /**
   * Context entries the listeners returned, in listener order. Always an
   * array (empty when none). On a halt it holds the context up to and
   * including the halting listener.
   */
  additionalContext: HookContextEntry[]
  /**
   * True when the halt came from a `failClosed` listener that threw, timed
   * out, or gave a malformed result, not from a real `halt` result.
   */
  failed?: boolean
  /**
   * Set with `failed`: the failing listener label and the error text, as
   * data. A caller that owns the model text builds it from these.
   */
  failure?: { label: string; detail: string }
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
}
