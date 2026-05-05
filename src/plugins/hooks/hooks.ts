/**
 * `Hooks` facade — single API for plugin authors and agent code.
 *
 * Routes registrations and emits to the right backend based on the
 * channel's declared shape:
 *
 * - `broadcast-async` -> existing {@link EventBus} (microtask-deferred,
 *   coalesce/throttle aware).
 * - `chain`, `broadcast-sync`, `stream` -> {@link HookBus}.
 *
 * Plugin authors call `hooks.on(channel, fn, opts)` and get the right
 * dispatcher by virtue of channel registration. They never need to
 * know which bus a channel rides.
 *
 * The facade also enforces:
 *
 * - Channel must be declared (in {@link CHANNELS}, or by an explicit
 *   `hooks.declare(name, shape)` call) — emits/listens on unknown
 *   channels throw.
 * - Listener priority is clamped per the source's privilege band.
 *
 * @module plugins/hooks/hooks
 */

import { EventBus, type Listener as EventListener } from "../event-bus.ts"
import { CHANNEL_BY_NAME } from "./channels.ts"
import { HookBus, type StreamHandle } from "./hook-bus.ts"
import type { ChainEmitResult, ChannelShape, Disposer, HookCtx, ListenOpts } from "./types.ts"

/**
 * Privilege of the caller registering a hook. Determines the priority
 * band the listener may use.
 */
export type CallerKind = "agent" | "plugin" | "system"

const PRIORITY_BAND: Record<CallerKind, [number, number]> = {
  plugin: [0, 100],
  agent: [1000, 9999],
  system: [10000, 1_000_000],
}

const DEFAULT_PRIORITY: Record<CallerKind, number> = {
  plugin: 50,
  agent: 5000,
  system: 50000,
}

export interface HooksOptions {
  /** Existing event bus to reuse for `broadcast-async`. Created if absent. */
  eventBus?: EventBus
  /** Underlying chain/sync/stream bus. Created if absent. */
  hookBus?: HookBus
  /** Diagnostic logger. */
  logger?: (msg: string) => void
  /**
   * If `UNSAFE_HOOKS=1` is set in the environment, plugin callers can
   * register listeners at any priority (otherwise their priority is
   * clamped to `[0..100]`). Defaults to reading `process.env`.
   */
  unsafeHooks?: boolean
}

export class Hooks {
  readonly eventBus: EventBus
  readonly hookBus: HookBus
  private readonly logger: (msg: string) => void
  private readonly unsafe: boolean
  /** Channels declared at runtime (not in the static catalog). */
  private readonly extra = new Map<string, ChannelShape>()

  constructor(opts: HooksOptions = {}) {
    this.logger = opts.logger ?? ((m) => process.stderr.write(`[hooks] ${m}\n`))
    this.eventBus = opts.eventBus ?? new EventBus(this.logger)
    this.hookBus = opts.hookBus ?? new HookBus(this.logger)
    this.unsafe = opts.unsafeHooks ?? process.env.UNSAFE_HOOKS === "1"
    // Pre-declare every catalog channel on the appropriate bus.
    for (const c of CHANNEL_BY_NAME.values()) {
      if (c.shape !== "broadcast-async") this.hookBus.declare(c.name, c.shape)
    }
  }

  /** Declare a runtime channel not present in the static catalog. */
  declare(channel: string, shape: ChannelShape): void {
    if (CHANNEL_BY_NAME.has(channel)) {
      throw new Error(`Hooks: channel "${channel}" is in the catalog, do not redeclare`)
    }
    const prior = this.extra.get(channel)
    if (prior && prior !== shape) {
      throw new Error(`Hooks: channel "${channel}" already declared as "${prior}"`)
    }
    this.extra.set(channel, shape)
    if (shape !== "broadcast-async") this.hookBus.declare(channel, shape)
  }

  /**
   * Subscribe a listener. The bus and clamping behaviour are decided
   * by the channel's shape and the caller's privilege.
   */
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-parameters
  on<T>(
    channel: string,
    fn: (payload: T, ctx: HookCtx) => unknown,
    opts?: ListenOpts & { caller?: CallerKind },
  ): Disposer
  on(
    channel: string,
    fn: (payload: unknown, ctx: HookCtx) => unknown,
    opts: ListenOpts & { caller?: CallerKind } = {},
  ): Disposer {
    const shape = this.shapeOf(channel)
    const caller = opts.caller ?? "plugin"
    const priority = this.clampPriority(channel, caller, opts.priority)
    const norm: ListenOpts = { ...opts, priority }
    if (shape === "broadcast-async") {
      // Adapt EventBus's (ctx) listener to our (payload, hookCtx) signature.
      const wrapped: EventListener = (ec) =>
        (fn as (payload: unknown, ctx: HookCtx) => unknown)(ec.payload, {
          channel: ec.event,
          abort: ec.abort,
          logger: this.logger,
          source: opts.source ?? caller,
          priority,
        }) as void | Promise<void>
      const off = this.eventBus.on(channel, wrapped, {
        coalesce: false,
        label: opts.label ?? `${opts.source ?? caller}:${channel}`,
      })
      return off
    }
    return this.hookBus.on(channel, fn, norm)
  }

  /** Emit a `broadcast-async` channel (fire-and-forget). */
  emitAsync(channel: string, payload?: unknown): void {
    this.assertShape(channel, "broadcast-async")
    this.eventBus.emit(channel, payload)
  }

  /** Emit a `broadcast-sync` channel (inline). */
  emitSync(channel: string, payload: unknown): void {
    this.assertShape(channel, "broadcast-sync")
    this.hookBus.emitSync(channel, payload)
  }

  /** Emit a `chain` channel and await the threaded result. */
  emitChain<T>(channel: string, payload: T): Promise<ChainEmitResult<T>> {
    this.assertShape(channel, "chain")
    return this.hookBus.emitChain(channel, payload)
  }

  /** Open a `stream` channel for production. */
  openStream<T>(channel: string): StreamHandle<T> {
    this.assertShape(channel, "stream")
    return this.hookBus.openStream<T>(channel)
  }

  /** Tear down everything. */
  dispose(): void {
    this.eventBus.dispose()
    this.hookBus.dispose()
  }

  // ---------------------------------------------------------------- internals

  private shapeOf(channel: string): ChannelShape {
    const c = CHANNEL_BY_NAME.get(channel)
    if (c) return c.shape
    const e = this.extra.get(channel)
    if (e) return e
    throw new Error(
      `Hooks: unknown channel "${channel}". Add it to channels.ts or call hooks.declare() first.`,
    )
  }

  private assertShape(channel: string, expected: ChannelShape): void {
    const actual = this.shapeOf(channel)
    if (actual !== expected) {
      throw new Error(`Hooks: channel "${channel}" has shape "${actual}", not "${expected}"`)
    }
  }

  private clampPriority(
    channel: string,
    caller: CallerKind,
    requested: number | undefined,
  ): number {
    const [lo, hi] = PRIORITY_BAND[caller]
    if (requested === undefined) return DEFAULT_PRIORITY[caller]
    if (caller === "plugin" && !this.unsafe) {
      if (requested < lo || requested > hi) {
        this.logger(
          `clamped priority ${requested} -> [${lo}..${hi}] for plugin listener on "${channel}" (set UNSAFE_HOOKS=1 to override)`,
        )
        return Math.min(hi, Math.max(lo, requested))
      }
    }
    return requested
  }
}
