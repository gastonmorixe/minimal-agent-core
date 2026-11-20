/**
 * HookBus — chain / broadcast-sync / stream dispatch.
 *
 * Complements the existing {@link EventBus} (broadcast-async). Where
 * `EventBus` is fire-and-forget and microtask-deferred, `HookBus` is
 * **transactional**: emitters await the chain and observe the final
 * payload, halts, and timeouts.
 *
 * Three shapes:
 *
 * - **chain**: payload threads through listeners in priority order
 *   (high → low). Each may mutate, replace, or halt. Halts are final.
 * - **broadcast-sync**: all listeners run inline in priority order;
 *   returns ignored. Errors logged, never thrown.
 * - **stream**: emitter calls {@link HookBus.openStream} and gets back
 *   `{push, close, finished}`. Listeners receive an `AsyncIterable<T>`
 *   that mirrors the producer.
 *
 * Priority space:
 *
 * - Plugins: `[0..100]` (clamped at registration).
 * - Agent internals: `[1000..9999]`.
 * - Reserved/system: `>= 10000`.
 *
 * Permission and `UNSAFE_HOOKS` enforcement live in the loader, not
 * here — this module is policy-free so it stays unit-testable.
 *
 * @module plugins/hooks/hook-bus
 */

import { processDiagnostics } from "../../diagnostics/hub.ts"
import { isHookContextEntry } from "../../sdk/hook-context.ts"

import type {
  ChainEmitOptions,
  ChainEmitResult,
  ChainListener,
  ChainResult,
  ChannelShape,
  Disposer,
  HookContextEntry,
  HookCtx,
  ListenOpts,
  StreamListener,
  SyncListener,
} from "./types.ts"

interface Entry {
  fn: (payload: unknown, ctx: HookCtx) => unknown
  opts: Required<Pick<ListenOpts, "priority" | "source" | "label">> &
    Pick<ListenOpts, "observeOnly" | "timeoutMs" | "failClosed">
  /** Insertion order tiebreaker so equal-priority listeners run FIFO. */
  seq: number
}

/** Snapshot returned by {@link HookBus.openStream} for a producer. */
export interface StreamHandle<T> {
  /** Push a value to all subscribers. No-op after `close()`. */
  push(value: T): void
  /** Signal end-of-stream. Subscribers' iterables complete. Idempotent. */
  close(): void
  /** Resolves when every subscriber's listener has finished. */
  finished: Promise<void>
}

/** The {@link HookBus.withTimeout} result when the caller signal aborted. */
const CALLER_ABORTED: unique symbol = Symbol("caller-aborted")

/**
 * One bus instance per agent process is enough. Disposal aborts every
 * outstanding listener via the shared signal.
 */
export class HookBus {
  /**
   * channel -\> shape (recorded on first declare or first on/emit).
   * Used to detect shape mismatches between declare/on/emit.
   */
  private readonly shapes = new Map<string, ChannelShape>()
  private readonly entries = new Map<string, Entry[]>()
  private readonly logger: (msg: string) => void
  private readonly abortCtl = new AbortController()
  private disposed = false
  private seqCounter = 0

  constructor(logger?: (msg: string) => void) {
    // Default sink: the process diagnostics handle. The plugin loader
    // passes its own logger (its injected diagnostics). Tests inject theirs.
    this.logger = logger ?? ((msg) => processDiagnostics().warn("plugin.hook-bus", msg))
  }

  /**
   * Record a channel's shape. Idempotent; throws on shape mismatch so
   * a misconfigured registry surfaces immediately.
   */
  declare(channel: string, shape: ChannelShape): void {
    const prior = this.shapes.get(channel)
    if (prior && prior !== shape) {
      throw new Error(
        `HookBus: channel "${channel}" already declared as "${prior}", cannot redeclare as "${shape}"`,
      )
    }
    this.shapes.set(channel, shape)
  }

  /** Subscribe a listener to `channel`. Returns a disposer. */
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters
  on<T>(channel: string, fn: (payload: T, ctx: HookCtx) => unknown, opts?: ListenOpts): Disposer
  on(
    channel: string,
    fn: (payload: unknown, ctx: HookCtx) => unknown,
    opts: ListenOpts = {},
  ): Disposer {
    if (this.disposed) return () => {}
    const source = opts.source ?? "anonymous"
    const priority = opts.priority ?? 50
    const label = opts.label ?? `${source}:${channel}`
    const entry: Entry = {
      fn: fn as (payload: unknown, ctx: HookCtx) => unknown,
      opts: {
        priority,
        source,
        label,
        observeOnly: opts.observeOnly,
        timeoutMs: opts.timeoutMs,
        failClosed: opts.failClosed,
      },
      seq: this.seqCounter++,
    }
    let arr = this.entries.get(channel)
    if (!arr) {
      arr = []
      this.entries.set(channel, arr)
    }
    arr.push(entry)
    // Sort high-priority first; FIFO on ties.
    arr.sort((a, b) =>
      b.opts.priority !== a.opts.priority ? b.opts.priority - a.opts.priority : a.seq - b.seq,
    )
    return () => {
      const cur = this.entries.get(channel)
      if (!cur) return
      const i = cur.indexOf(entry)
      if (i >= 0) cur.splice(i, 1)
      if (cur.length === 0) this.entries.delete(channel)
    }
  }

  /**
   * Dispatch a `chain` channel. Threads `payload` through listeners in
   * priority order. Returns the final payload + halt info.
   *
   * Throws only on shape mismatch (programmer error). Listener errors
   * are logged and treated as pass-through, EXCEPT for a `failClosed`
   * listener (an approval gate): its throw, rejection, or timeout halts
   * the chain with `failed` and the `failure` facts (no reason text), so a
   * failed gate denies and never allows.
   *
   * `opts.signal` (the caller signal): each listener gets it in `ctx.abort`.
   * When it aborts, the chain ends at once with no halt (see
   * {@link ChainEmitOptions.signal}).
   */
  async emitChain<T>(
    channel: string,
    payload: T,
    opts: ChainEmitOptions = {},
  ): Promise<ChainEmitResult<T>> {
    this.assertShape(channel, "chain")
    if (this.disposed) return { payload, halted: false, additionalContext: [] }
    const callerSignal = opts.signal
    if (callerSignal?.aborted) return { payload, halted: false, additionalContext: [] }
    const abort = callerSignal
      ? AbortSignal.any([this.abortCtl.signal, callerSignal])
      : this.abortCtl.signal
    const list = this.snapshot(channel)
    let cur = payload
    const additionalContext: HookContextEntry[] = []
    for (const entry of list) {
      const ctx = this.makeCtx(channel, entry, abort)
      const fn = entry.fn as ChainListener<T>
      let awaited: ChainResult<T>
      try {
        const result: ChainResult<T> | Promise<ChainResult<T>> = fn(cur, ctx)
        const settled = await this.withTimeout(channel, entry, result, callerSignal)
        if (settled === CALLER_ABORTED) return { payload: cur, halted: false, additionalContext }
        awaited = settled
      } catch (e) {
        this.reportError(entry, channel, e)
        if (entry.opts.failClosed) {
          return {
            payload: cur,
            halted: true,
            haltedBy: entry.opts.source,
            additionalContext,
            failed: true,
            failure: failureFacts(entry, e),
          }
        }
        continue
      }
      if (entry.opts.failClosed) {
        // An approval gate must answer with a well-formed result. A
        // malformed one denies, the same as a throw.
        const bad = malformedResult(cur, awaited)
        if (bad) {
          this.reportError(entry, channel, new Error(bad))
          return {
            payload: cur,
            halted: true,
            haltedBy: entry.opts.source,
            additionalContext,
            failed: true,
            failure: failureFacts(entry, bad),
          }
        }
      }
      if (!awaited) continue // pass-through
      if (entry.opts.observeOnly) {
        // observation-only listeners must not mutate
        this.logger(
          `[hook-bus] listener "${entry.opts.label}" on "${channel}" returned a payload but is observeOnly; ignored`,
        )
        continue
      }
      pushContext(additionalContext, awaited)
      if ("payload" in awaited) cur = awaited.payload
      if ("halt" in awaited && awaited.halt) {
        return {
          payload: cur,
          halted: true,
          haltedBy: entry.opts.source,
          reason: "reason" in awaited ? awaited.reason : undefined,
          additionalContext,
        }
      }
    }
    return { payload: cur, halted: false, additionalContext }
  }

  /**
   * Dispatch a `broadcast-sync` channel. Listeners run inline in
   * priority order. Returns after the last one. Errors logged.
   */
  emitSync(channel: string, payload: unknown): void {
    this.assertShape(channel, "broadcast-sync")
    if (this.disposed) return
    const list = this.snapshot(channel)
    for (const entry of list) {
      const ctx = this.makeCtx(channel, entry)
      try {
        ;(entry.fn as SyncListener<unknown>)(payload, ctx)
      } catch (e) {
        this.reportError(entry, channel, e)
      }
    }
  }

  /**
   * Open a `stream` channel. Returns a producer handle. Subscribers
   * (registered via {@link on}) are invoked once per stream, each with
   * its own `AsyncIterable<T>`. The iterables complete after `close()`.
   *
   * Late subscribers (registered after `push` calls) only see values
   * pushed after they subscribed — this is a multicast push stream,
   * not a replay log.
   */
  openStream<T>(channel: string): StreamHandle<T> {
    this.assertShape(channel, "stream")
    type Sub = {
      queue: T[]
      resolveNext: ((v: IteratorResult<T>) => void) | null
      done: boolean
    }
    const subs: Sub[] = []
    let closed = false
    const listenerPromises: Promise<unknown>[] = []

    const list = this.snapshot(channel)
    for (const entry of list) {
      const sub: Sub = { queue: [], resolveNext: null, done: false }
      subs.push(sub)
      const iterable: AsyncIterable<T> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<T>> {
              if (sub.queue.length > 0) {
                const v = sub.queue.shift() as T
                return Promise.resolve({ value: v, done: false })
              }
              if (sub.done) return Promise.resolve({ value: undefined as T, done: true })
              return new Promise<IteratorResult<T>>((res) => {
                sub.resolveNext = res
              })
            },
            return(): Promise<IteratorResult<T>> {
              sub.done = true
              return Promise.resolve({ value: undefined as T, done: true })
            },
          }
        },
      }
      const ctx = this.makeCtx(channel, entry)
      try {
        const p = (entry.fn as StreamListener<T>)(iterable, ctx)
        if (p && typeof (p as Promise<unknown>).then === "function") {
          listenerPromises.push(
            (p as Promise<unknown>).catch((e) => this.reportError(entry, channel, e)),
          )
        }
      } catch (e) {
        this.reportError(entry, channel, e)
      }
    }

    return {
      push(value: T): void {
        if (closed) return
        for (const sub of subs) {
          if (sub.done) continue
          if (sub.resolveNext) {
            const r = sub.resolveNext
            sub.resolveNext = null
            r({ value, done: false })
          } else {
            sub.queue.push(value)
          }
        }
      },
      close(): void {
        if (closed) return
        closed = true
        for (const sub of subs) {
          sub.done = true
          if (sub.resolveNext) {
            const r = sub.resolveNext
            sub.resolveNext = null
            r({ value: undefined as T, done: true })
          }
        }
      },
      finished: Promise.allSettled(listenerPromises).then(() => undefined),
    }
  }

  /** Drop everything. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.entries.clear()
    this.abortCtl.abort()
  }

  /** Test helper. */
  listenerCount(channel: string): number {
    return this.entries.get(channel)?.length ?? 0
  }

  /** Number of `failClosed` listeners (approval gates) on `channel`. */
  failClosedCount(channel: string): number {
    return this.entries.get(channel)?.filter((e) => e.opts.failClosed === true).length ?? 0
  }

  // ---------------------------------------------------------------- internals

  private snapshot(channel: string): Entry[] {
    const arr = this.entries.get(channel)
    return arr ? [...arr] : []
  }

  private assertShape(channel: string, expected: ChannelShape): void {
    const prior = this.shapes.get(channel)
    if (prior && prior !== expected) {
      throw new Error(
        `HookBus: channel "${channel}" was declared as "${prior}" but emitted as "${expected}"`,
      )
    }
    if (!prior) this.shapes.set(channel, expected)
  }

  private makeCtx(channel: string, entry: Entry, abort?: AbortSignal): HookCtx {
    return {
      channel,
      abort: abort ?? this.abortCtl.signal,
      logger: this.logger,
      source: entry.opts.source,
      priority: entry.opts.priority,
    }
  }

  /**
   * Await `result`, bounded by the listener `timeoutMs` and by `callerSignal`.
   * An abort of `callerSignal` gives {@link CALLER_ABORTED} at once and clears
   * the timer.
   *
   * The timeout timer stays ref'd on purpose. It keeps the event loop alive
   * while a chain waits for a listener that waits only on unref'd handles
   * (for example the ma-background `turn.willStop` hook, which polls with an
   * unref'd sleep). An unref'd timer would let a headless process exit in the
   * middle of the chain, on every channel. The timer never outlives the
   * chain: it is cleared when the listener settles, times out, or when the
   * caller signal aborts.
   */
  private async withTimeout<T>(
    channel: string,
    entry: Entry,
    result: T | Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T | typeof CALLER_ABORTED> {
    const ms = entry.opts.timeoutMs && entry.opts.timeoutMs > 0 ? entry.opts.timeoutMs : 0
    if (!isThenable(result) || (!ms && !callerSignal)) return await (result as Promise<T>)
    let timer: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null
    const racers: Promise<T | typeof CALLER_ABORTED>[] = [result as Promise<T>]
    if (ms) {
      racers.push(
        new Promise<never>((_, rej) => {
          timer = setTimeout(
            () =>
              rej(
                new Error(
                  `listener "${entry.opts.label}" on "${channel}" exceeded ${ms}ms timeout`,
                ),
              ),
            ms,
          )
        }),
      )
    }
    if (callerSignal) {
      racers.push(
        new Promise<typeof CALLER_ABORTED>((res) => {
          onAbort = () => res(CALLER_ABORTED)
          callerSignal.addEventListener("abort", onAbort, { once: true })
        }),
      )
    }
    try {
      return await Promise.race(racers)
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort && callerSignal) callerSignal.removeEventListener("abort", onAbort)
    }
  }

  private reportError(entry: Entry, channel: string, err: unknown): void {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    this.logger(`listener "${entry.opts.label}" on "${channel}" threw: ${msg}`)
  }
}

function isThenable(x: unknown): x is Promise<unknown> {
  return typeof x === "object" && x !== null && typeof (x as { then?: unknown }).then === "function"
}

/**
 * Check the result of a `failClosed` listener. Return a problem text, or
 * null when the result is well formed. A result must be undefined, null,
 * or an object. When the current payload is an object, a returned
 * `payload` must also be an object.
 */
function malformedResult(cur: unknown, result: unknown): string | null {
  if (result === undefined || result === null) return null
  if (typeof result !== "object") return `malformed result: ${typeof result}`
  if ("additionalContext" in result && !isEntryArray(result.additionalContext)) {
    return "malformed additionalContext: expected string or { text, position } entries"
  }
  if (!("payload" in result)) return null
  const next: unknown = result.payload
  const curIsObject = typeof cur === "object" && cur !== null
  const nextIsObject = typeof next === "object" && next !== null
  if (curIsObject && !nextIsObject) {
    return `malformed payload: ${next === null ? "null" : typeof next}`
  }
  return null
}

function isEntryArray(x: unknown): x is HookContextEntry[] {
  return Array.isArray(x) && x.every(isHookContextEntry)
}

/**
 * Append the entries of a listener's `additionalContext` to `into`, as
 * they are. A non-array value or a malformed entry is skipped.
 */
function pushContext(into: HookContextEntry[], result: object): void {
  if (!("additionalContext" in result)) return
  const ctx: unknown = result.additionalContext
  if (!Array.isArray(ctx)) return
  for (const s of ctx) if (isHookContextEntry(s)) into.push(s)
}

function failureFacts(entry: Entry, err: unknown): { label: string; detail: string } {
  return { label: entry.opts.label, detail: err instanceof Error ? err.message : String(err) }
}
