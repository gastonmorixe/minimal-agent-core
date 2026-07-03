/**
 * NetworkActivityObserver — bridges the {@link NetworkClient} observer
 * hooks to a {@link StatusHandle}, so the status row can show live
 * "↑ N bytes" / "↓ N bytes" counters as a real network request flies.
 *
 * # How callers use it
 *
 * Each {@link sendMessage} request follows this lifecycle:
 *
 * 1. Caller creates a status entry: `const handle = bus.create("Sending", ...)`.
 * 2. Caller pre-generates a request id: `const reqId = randomUUID()`.
 * 3. Caller binds the handle: `networkActivityObserver.attach(reqId, handle, opts)`.
 * 4. Caller fires the request: `networkClient.request({id: reqId, ...})`.
 * 5. Observer hooks fire automatically:
 *    - `onRequest` records the request body byte length as `sentBytes` and
 *      extracts `target.host` from the URL.
 *    - `onResponse` records `target.protocol` (`"h2"`, `"http/1.1"`, ...).
 *    - `onChunk` accumulates `recvBytes`, throttled to ~10 emits/sec so the
 *      status renderer doesn't repaint on every TCP packet.
 *    - `onEnd` / `onError` flush the final `recvBytes` value with
 *      `direction: "idle"` so the row settles.
 * 6. Caller detaches in finally: `networkActivityObserver.detach(reqId)`.
 *
 * # Wiring
 *
 * A module-level singleton {@link networkActivityObserver} is exported
 * here and registered on {@link createDefaultNetworkClient}'s observer
 * list. Custom `NetworkClient` instances (e.g. in tests) can opt in by
 * including the singleton in their own `observers` array.
 *
 * Calling `attach()` when the observer is NOT wired into any active
 * NetworkClient is a no-op: the registry retains the tracker but no
 * callback ever finds it. This is safe — the status entry just won't get
 * byte updates.
 *
 * @module network/activity-observer
 */

import type { StatusActivityTarget, StatusHandle } from "../bus/status.ts"

import type { NetworkObserver, NetworkRequest, NetworkResponse } from "./types.ts"

export interface NetworkActivityAttachOptions {
  /** Initial hint text to display (e.g. tool name). Optional. */
  hint?: string
  /** Override the wall clock for deterministic testing. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Minimum interval between `onChunk`-driven activity updates. Defaults
   * to 100ms (= 10 emits/sec) which is plenty for byte counters and
   * matches the existing SSE delta throttle in `client.ts`.
   */
  throttleMs?: number
}

/**
 * Per-request tracker. One instance owns the `StatusHandle` for the
 * duration of a single request. Created internally by
 * {@link NetworkActivityObserver.attach}.
 */
export class NetworkActivityTracker {
  private recvBytes = 0
  private lastEmit = 0
  private lastChunkAt = 0
  readonly throttleMs: number

  constructor(
    private readonly handle: StatusHandle,
    private readonly hint: string | undefined,
    private readonly now: () => number,
    throttleMs: number,
  ) {
    this.throttleMs = throttleMs
  }

  /** Called by the observer when the network client queues the request. */
  onRequest(req: NetworkRequest): void {
    const sentBytes = bodyByteLength(req.body)
    const host = safeHost(req.url)
    const target: StatusActivityTarget | undefined = host ? { host } : undefined
    this.handle.updateActivity({
      direction: "up",
      sentBytes,
      hint: this.hint,
      ...(target ? { target } : {}),
    })
  }

  /** Called when the transport reports the response headers. */
  onResponse(res: NetworkResponse): void {
    const protocol = res.transport.protocol
    if (!protocol) return
    this.handle.updateActivity({
      target: { protocol },
    })
  }

  /**
   * Called for every body chunk. Throttled internally for the status
   * update, but `lastChunkAt` is bumped on EVERY chunk so the stalled
   * detector in `formatActivityInfix` (see {@link STALL_THRESHOLD_MS})
   * has truthful "did the wire just go silent" data. The bump and the
   * emit are decoupled deliberately:
   *
   *   - `lastChunkAt` MUST be fresh (per-chunk) — otherwise a steady
   *     stream of 50-byte SSE pings within the throttle window would
   *     look stalled because the last EMIT was \>2s ago, even though
   *     the wire is healthy.
   *   - The status update is still throttled (default 100ms) so we
   *     don't repaint the row on every TCP frame.
   *
   * The emitted activity payload always carries the latest `lastChunkAt`,
   * even on the throttle-coalesced emits, so the next renderer paint
   * sees the right "last byte" timestamp without needing its own
   * out-of-band hook.
   */
  onChunk(chunk: Uint8Array): void {
    this.recvBytes += chunk.byteLength
    const now = this.now()
    this.lastChunkAt = now
    if (now - this.lastEmit < this.throttleMs) return
    this.lastEmit = now
    this.handle.updateActivity({
      direction: "down",
      recvBytes: this.recvBytes,
      lastChunkAt: this.lastChunkAt,
    })
  }

  /** Called when the response body stream closes normally. Flushes final value. */
  onEnd(): void {
    this.handle.updateActivity({
      direction: "idle",
      recvBytes: this.recvBytes,
      lastChunkAt: this.lastChunkAt > 0 ? this.lastChunkAt : undefined,
    })
  }

  /** Called on transport error. Flushes whatever recvBytes we have. */
  onError(_err: unknown): void {
    this.handle.updateActivity({
      direction: "idle",
      recvBytes: this.recvBytes,
      lastChunkAt: this.lastChunkAt > 0 ? this.lastChunkAt : undefined,
    })
  }

  /** Test helper: timestamp of the most recent chunk (0 if none). */
  lastChunkTimestamp(): number {
    return this.lastChunkAt
  }

  /** Test helper: current accumulated recvBytes. */
  receivedBytes(): number {
    return this.recvBytes
  }
}

/**
 * Module-scoped singleton observer. Registered on the default network
 * client and exported for callers (client.ts) to `attach`/`detach` around
 * their own requests.
 */
export class NetworkActivityObserver implements NetworkObserver {
  private trackers = new Map<string, NetworkActivityTracker>()

  /**
   * Bind a {@link StatusHandle} to a pre-generated request id. The
   * returned tracker stays alive until {@link detach} is called.
   */
  attach(
    reqId: string,
    handle: StatusHandle,
    opts: NetworkActivityAttachOptions = {},
  ): NetworkActivityTracker {
    const tracker = new NetworkActivityTracker(
      handle,
      opts.hint,
      opts.now ?? Date.now,
      opts.throttleMs ?? 100,
    )
    this.trackers.set(reqId, tracker)
    return tracker
  }

  /** Remove the tracker for a given request id. Idempotent. */
  detach(reqId: string): void {
    this.trackers.delete(reqId)
  }

  /** Test helper: is anything currently tracked. */
  size(): number {
    return this.trackers.size
  }

  onRequest(req: NetworkRequest): void {
    this.trackers.get(req.id)?.onRequest(req)
  }

  onResponse(req: NetworkRequest, res: NetworkResponse): void {
    this.trackers.get(req.id)?.onResponse(res)
  }

  onChunk(req: NetworkRequest, chunk: Uint8Array): void {
    this.trackers.get(req.id)?.onChunk(chunk)
  }

  onEnd(req: NetworkRequest): void {
    this.trackers.get(req.id)?.onEnd()
  }

  onError(req: NetworkRequest, err: unknown): void {
    this.trackers.get(req.id)?.onError(err)
  }
}

/** Process-wide singleton wired into {@link createDefaultNetworkClient}. */
export const networkActivityObserver = new NetworkActivityObserver()

function bodyByteLength(body: string | Uint8Array | undefined): number {
  if (body == null) return 0
  if (typeof body === "string") return Buffer.byteLength(body, "utf8")
  return body.byteLength
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}
