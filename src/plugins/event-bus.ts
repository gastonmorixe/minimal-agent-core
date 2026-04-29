/**
 * Async, low-priority event bus for the plugin runtime.
 *
 * Why a bus?
 * ----------
 * Plugins need to react to host signals that don't fit the existing
 * trigger model (`tool` / `inline_tag`). Examples:
 *
 *   - `prompt.input.changed`  — the user typed in the prompt input field.
 *     The ASK-mode plugin uses this to detect questions and propose a
 *     mode switch.
 *   - `mode.set.request`      — a plugin asks the host to change the
 *     active mode. The REPL is the listener.
 *   - `mode.changed`          — the host announces the active mode
 *     changed (lifecycle).
 *
 * Hot-path constraints
 * --------------------
 * The bus is fed from interactive paths (every keystroke). Its dispatch
 * MUST NOT block the producer:
 *
 *   - {@link EventBus.emit} returns synchronously after queueing. It does
 *     not await listeners.
 *   - Listener invocations are scheduled via `queueMicrotask` so they run
 *     after the current task drains, never inline. (Microtasks are
 *     fast — same turn as a resolved promise — but they still let the
 *     caller's stack unwind first, which is what we want for input.)
 *   - Listener errors are caught and routed to the optional `logger`.
 *     One bad listener never breaks the rest.
 *
 * Coalescing
 * ----------
 * For high-frequency events, listeners can opt in to coalescing
 * (`{coalesce: true}`):
 *
 *   - At most ONE invocation is in flight per (event, listener) pair.
 *   - While a listener is running, additional emits overwrite a single
 *     "pending" slot. When the in-flight call resolves, the pending
 *     payload (if any) fires the listener once more — with the LATEST
 *     payload, not a queue of all intermediate ones.
 *
 * This is exactly what we want for `prompt.input.changed`: if the user
 * is typing fast, we don't want a backlog of stale buffer states; we
 * want the listener to keep up with the latest.
 *
 * Throttling
 * ----------
 * Listeners can also declare `{throttleMs: N}`. Within an N-ms window,
 * additional emits are dropped on the floor (the trailing edge is NOT
 * delivered). Combine with coalescing if you want trailing-edge behavior.
 *
 * @module plugins/event-bus
 */

/**
 * Listener invocation context. Same shape regardless of event.
 */
export interface EventContext<TPayload = unknown> {
  /** The event name that triggered this invocation. */
  readonly event: string
  /** Payload provided by the emitter. Shape is event-specific. */
  readonly payload: TPayload
  /**
   * Re-emit on the same bus. Useful when a handler reacts to one event
   * by raising another (e.g. ASK detector emits `mode.set.request`).
   */
  readonly emit: (event: string, payload?: unknown) => void
  /**
   * Aborts when the bus is being torn down. Long-running listeners
   * should respect this so the process can exit cleanly.
   */
  readonly abort: AbortSignal
}

/**
 * Listener function. Errors are caught by the bus and never propagate.
 *
 * Returning a Promise is supported. The bus tracks in-flight listener
 * promises for coalescing; it does NOT await them in {@link emit}.
 */
export type Listener<TPayload = unknown> = (
  ctx: EventContext<TPayload>,
) => void | Promise<void>

/** Options for {@link EventBus.on}. */
export interface ListenerOptions {
  /**
   * If true, only one invocation runs at a time per listener. While one
   * is in flight, intermediate emits collapse into a single "pending"
   * slot keyed by the latest payload. Default false.
   */
  coalesce?: boolean
  /**
   * Minimum interval in milliseconds between deliveries to this
   * listener. Emits inside the window are dropped (no trailing edge).
   * Default 0 (no throttling).
   */
  throttleMs?: number
  /**
   * Diagnostic label used in error messages. Defaults to
   * `"<anonymous listener>"`.
   */
  label?: string
}

/** Unsubscribe handle returned by {@link EventBus.on}. */
export type Unsubscribe = () => void

interface ListenerEntry {
  fn: Listener
  opts: ListenerOptions
  /** Last invocation start timestamp (ms, performance.now). */
  lastInvokedAt: number
  /** True while an async invocation is in flight (coalesce only). */
  inFlight: boolean
  /**
   * Pending payload to deliver after the in-flight invocation resolves
   * (coalesce only). The slot is overwritten by later emits — only the
   * latest survives. `undefined` means "no pending invocation".
   *
   * We use a wrapper object instead of `payload | undefined` so an
   * emitted `undefined` payload still triggers a delivery.
   */
  pending: { payload: unknown } | null
}

/**
 * Event bus instance. One per agent process.
 *
 * Construction is cheap; the bus does no work until something is
 * emitted or subscribed.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<ListenerEntry>>()
  private readonly logger: (msg: string) => void
  private readonly abortCtl = new AbortController()
  private disposed = false

  /**
   * @param logger - Diagnostic sink for listener errors. Defaults to
   *   writing to `process.stderr`. Pass a no-op in tests.
   */
  constructor(logger?: (msg: string) => void) {
    this.logger = logger ?? ((msg) => process.stderr.write(`[event-bus] ${msg}\n`))
  }

  /**
   * Subscribe a listener to `event`. Returns an unsubscribe handle.
   *
   * Subscribing the same function twice with the same options results
   * in TWO active subscriptions — the bus does not deduplicate. Use the
   * returned handle to detach.
   */
  on<T = unknown>(event: string, fn: Listener<T>, opts: ListenerOptions = {}): Unsubscribe {
    if (this.disposed) return () => {}
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const entry: ListenerEntry = {
      fn: fn as Listener,
      opts,
      lastInvokedAt: 0,
      inFlight: false,
      pending: null,
    }
    set.add(entry)
    return () => {
      const s = this.listeners.get(event)
      if (!s) return
      s.delete(entry)
      if (s.size === 0) this.listeners.delete(event)
    }
  }

  /**
   * Schedule a fanout for `event` with `payload`. Returns synchronously
   * after queueing — listeners run on the microtask tick.
   *
   * Safe to call from hot paths (per-keystroke). Cost is O(number of
   * listeners on `event`), each O(1) bookkeeping.
   */
  emit(event: string, payload?: unknown): void {
    if (this.disposed) return
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return

    // Snapshot to a small array so unsubscribes during dispatch don't
    // mutate the iteration. ListenerEntry mutations (pending/inFlight)
    // happen on the entry itself; the snapshot just freezes membership.
    const entries: ListenerEntry[] = []
    for (const e of set) entries.push(e)

    queueMicrotask(() => {
      for (const entry of entries) {
        // Re-check membership after the tick — the listener may have
        // unsubscribed itself between emit() and microtask drain.
        const live = this.listeners.get(event)
        if (!live || !live.has(entry)) continue
        this.deliver(event, payload, entry)
      }
    })
  }

  /**
   * Drop all listeners and abort the shared signal. Subsequent
   * {@link emit} / {@link on} calls become no-ops.
   *
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.abortCtl.abort()
  }

  /** Test helper. Number of active listeners on `event`. */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  /** Test helper. List of currently registered event names. */
  eventNames(): string[] {
    return [...this.listeners.keys()]
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private deliver(event: string, payload: unknown, entry: ListenerEntry): void {
    const { opts } = entry
    const now = nowMs()

    // Throttle: drop if inside the window.
    if (opts.throttleMs && opts.throttleMs > 0) {
      if (now - entry.lastInvokedAt < opts.throttleMs) return
    }

    // Coalesce: if a previous invocation is still running, stash the
    // latest payload and let the in-flight resolution drain it.
    if (opts.coalesce && entry.inFlight) {
      entry.pending = { payload }
      return
    }

    entry.lastInvokedAt = now
    this.invoke(event, payload, entry)
  }

  private invoke(event: string, payload: unknown, entry: ListenerEntry): void {
    const ctx: EventContext = {
      event,
      payload,
      emit: (e, p) => this.emit(e, p),
      abort: this.abortCtl.signal,
    }

    let result: void | Promise<void>
    try {
      result = entry.fn(ctx)
    } catch (e) {
      this.reportError(event, entry, e)
      return
    }

    if (!isPromise(result)) return

    if (entry.opts.coalesce) {
      entry.inFlight = true
      result
        .catch((e: unknown) => this.reportError(event, entry, e))
        .finally(() => {
          entry.inFlight = false
          // Drain a pending invocation if any. Use the LATEST stashed
          // payload — earlier ones were intentionally dropped.
          const next = entry.pending
          entry.pending = null
          if (next) {
            entry.lastInvokedAt = nowMs()
            this.invoke(event, next.payload, entry)
          }
        })
    } else {
      result.catch((e: unknown) => this.reportError(event, entry, e))
    }
  }

  private reportError(event: string, entry: ListenerEntry, err: unknown): void {
    const label = entry.opts.label ?? "<anonymous listener>"
    const msg = err instanceof Error ? err.stack ?? err.message : String(err)
    this.logger(`listener "${label}" for "${event}" threw: ${msg}`)
  }
}

function nowMs(): number {
  // performance.now is monotonic; Date.now is fine on both Bun and Node.
  // Bun has performance globally; fall through to Date.now if not.
  const p = (globalThis as { performance?: { now(): number } }).performance
  return p ? p.now() : Date.now()
}

function isPromise(x: unknown): x is Promise<unknown> {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { then?: unknown }).then === "function"
  )
}
