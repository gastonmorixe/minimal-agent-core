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

import type {
  ChainEmitResult,
  ChainListener,
  ChainResult,
  ChannelShape,
  Disposer,
  HookCtx,
  ListenOpts,
  StreamListener,
  SyncListener,
} from "./types.ts"

interface Entry {
  fn: (...args: unknown[]) => unknown
  opts: Required<Pick<ListenOpts, "priority" | "source" | "label">> &
    Pick<ListenOpts, "observeOnly" | "timeoutMs">
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

/**
 * One bus instance per agent process is enough. Disposal aborts every
 * outstanding listener via the shared signal.
 */
export class HookBus {
  /**
   * channel -> shape (recorded on first declare or first on/emit).
   * Used to detect shape mismatches between declare/on/emit.
   */
  private readonly shapes = new Map<string, ChannelShape>()
  private readonly entries = new Map<string, Entry[]>()
  private readonly logger: (msg: string) => void
  private readonly abortCtl = new AbortController()
  private disposed = false
  private seqCounter = 0

  constructor(logger?: (msg: string) => void) {
    this.logger = logger ?? ((msg) => process.stderr.write(`[hook-bus] ${msg}\n`))
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
  on<T>(channel: string, fn: (...args: unknown[]) => unknown, opts: ListenOpts = {}): Disposer {
    if (this.disposed) return () => {}
    const source = opts.source ?? "anonymous"
    const priority = opts.priority ?? 50
    const label = opts.label ?? `${source}:${channel}`
    const entry: Entry = {
      fn,
      opts: {
        priority,
        source,
        label,
        observeOnly: opts.observeOnly,
        timeoutMs: opts.timeoutMs,
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
    // suppress unused TS warning for generic T
    void (undefined as unknown as T)
  }

  /**
   * Dispatch a `chain` channel. Threads `payload` through listeners in
   * priority order. Returns the final payload + halt info.
   *
   * Throws only on shape mismatch (programmer error). Listener errors
   * are logged and treated as pass-through.
   */
  async emitChain<T>(channel: string, payload: T): Promise<ChainEmitResult<T>> {
    this.assertShape(channel, "chain")
    if (this.disposed) return { payload, halted: false }
    const list = this.snapshot(channel)
    let cur = payload
    for (const entry of list) {
      const ctx = this.makeCtx(channel, entry)
      const fn = entry.fn as ChainListener<T>
      let result: ChainResult<T> | Promise<ChainResult<T>>
      try {
        result = fn(cur, ctx)
      } catch (e) {
        this.reportError(entry, channel, e)
        continue
      }
      let awaited: ChainResult<T>
      try {
        awaited = await this.withTimeout(channel, entry, result)
      } catch (e) {
        this.reportError(entry, channel, e)
        continue
      }
      if (!awaited) continue // pass-through
      if (entry.opts.observeOnly) {
        // observation-only listeners must not mutate
        this.logger(
          `[hook-bus] listener "${entry.opts.label}" on "${channel}" returned a payload but is observeOnly; ignored`,
        )
        continue
      }
      if ("payload" in awaited) cur = awaited.payload
      if ("halt" in awaited && awaited.halt) {
        return {
          payload: cur,
          halted: true,
          haltedBy: entry.opts.source,
          reason: "reason" in awaited ? awaited.reason : undefined,
        }
      }
    }
    return { payload: cur, halted: false }
  }

  /**
   * Dispatch a `broadcast-sync` channel. Listeners run inline in
   * priority order. Returns after the last one. Errors logged.
   */
  emitSync<T>(channel: string, payload: T): void {
    this.assertShape(channel, "broadcast-sync")
    if (this.disposed) return
    const list = this.snapshot(channel)
    for (const entry of list) {
      const ctx = this.makeCtx(channel, entry)
      try {
        ;(entry.fn as SyncListener<T>)(payload, ctx)
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

  private makeCtx(channel: string, entry: Entry): HookCtx {
    return {
      channel,
      abort: this.abortCtl.signal,
      logger: this.logger,
      source: entry.opts.source,
      priority: entry.opts.priority,
    }
  }

  private async withTimeout<T>(
    channel: string,
    entry: Entry,
    result: T | Promise<T>,
  ): Promise<T> {
    if (!isThenable(result) || !entry.opts.timeoutMs || entry.opts.timeoutMs <= 0) {
      return await (result as Promise<T>)
    }
    const ms = entry.opts.timeoutMs
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeoutP = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () =>
          rej(
            new Error(
              `listener "${entry.opts.label}" on "${channel}" exceeded ${ms}ms timeout`,
            ),
          ),
        ms,
      )
    })
    try {
      return await Promise.race([result as Promise<T>, timeoutP])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private reportError(entry: Entry, channel: string, err: unknown): void {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
    this.logger(`listener "${entry.opts.label}" on "${channel}" threw: ${msg}`)
  }
}

function isThenable(x: unknown): x is Promise<unknown> {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { then?: unknown }).then === "function"
  )
}
