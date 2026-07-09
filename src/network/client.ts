import { randomUUID } from "node:crypto"

import { networkActivityObserver } from "./activity-observer.ts"
import { FetchTransport } from "./fetch-transport.ts"
import { Http2Transport } from "./http2-transport.ts"
import { Http3NegotiationCache } from "./http3-cache.ts"
import { Http3Transport } from "./http3-transport.ts"
import { createNetDebugObserver } from "./net-dbg-observer.ts"
import { http3OpportunisticPolicy } from "./policies/h3-opportunistic.ts"
import { TestTransport } from "./test-transport.ts"
import {
  type NetworkObserver,
  type NetworkPolicy,
  type NetworkProtocol,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./types.ts"

export interface NetworkClientOptions {
  primary: NetworkTransport
  fallback?: NetworkTransport
  observers?: NetworkObserver[]
  allowFetchFallback?: boolean
  /**
   * Additional transports keyed by `NetworkProtocol`. When a request
   * carries `protocol: "h3"` (typically pinned by
   * {@link http3OpportunisticPolicy}), the client routes to
   * `transports.get("h3")` instead of `primary`. Missing entries
   * fall through to `primary`.
   *
   * The protocol values match {@link NetworkProtocol}, NOT the
   * transport ids (`"http3"`, `"http2"`, ...) — same convention as
   * `req.protocol` on the wire.
   */
  transports?: Map<NetworkProtocol, NetworkTransport>
  /**
   * Transport for plaintext `http://` requests. The default HTTP/2 transport
   * connects with h2c prior-knowledge, which a plain HTTP/1.1 server (LM Studio,
   * vLLM, a local proxy) never answers, so the stream hangs. When this is set,
   * any `http://` (non-TLS) URL is routed here instead of `primary`. `https://`
   * traffic is unaffected. Set to a {@link FetchTransport} in the default client;
   * omit (or pin `MINIMAL_AGENT_TRANSPORT`) to disable the auto-route.
   */
  plaintextHttpTransport?: NetworkTransport
  /**
   * Middleware applied to each request in registration order.
   * `onRequest` runs outer→inner, `wrap` nests outer-around-inner,
   * `onResponse` runs inner→outer (LIFO so the outermost policy
   * sees the final substituted response). See {@link NetworkPolicy}.
   */
  policies?: NetworkPolicy[]
}

export type NetworkRequestInput = Omit<NetworkRequest, "id" | "transportHint"> & {
  id?: string
}

/** Transport-agnostic network client with observers and fallback control. */
export class NetworkClient {
  private readonly primary: NetworkTransport
  private readonly fallback?: NetworkTransport
  private readonly observers: NetworkObserver[]
  private readonly allowFetchFallback: boolean
  private readonly transports: Map<NetworkProtocol, NetworkTransport>
  private readonly plaintextHttpTransport?: NetworkTransport
  private readonly policies: NetworkPolicy[]

  constructor(opts: NetworkClientOptions) {
    this.primary = opts.primary
    this.fallback = opts.fallback
    this.observers = opts.observers ?? []
    this.allowFetchFallback = opts.allowFetchFallback ?? false
    this.transports = opts.transports ?? new Map()
    this.plaintextHttpTransport = opts.plaintextHttpTransport
    this.policies = opts.policies ?? []
  }

  async request(input: NetworkRequestInput): Promise<NetworkResponse> {
    let req: NetworkRequest = {
      ...input,
      id: input.id ?? randomUUID(),
      transportHint: this.primary.id,
    }

    // 1. Pre-flight: run `onRequest` policies in registration order.
    //    Each may rewrite `req`. We notify observers AFTER policies
    //    so the captured req matches what actually goes on the wire.
    for (const policy of this.policies) {
      if (!policy.onRequest) continue
      const out = await policy.onRequest(req)
      if (out) req = { ...out, id: req.id, transportHint: req.transportHint }
    }
    this.notifyRequest(req)

    // 2. Build the inner "do one round-trip" thunk. Knows about
    //    transport selection, fetch fallback, and observer fan-out;
    //    DOES NOT know about policy chains (so wrap()'s retry path
    //    can re-invoke this thunk without re-running policies).
    const fire = async (current: NetworkRequest): Promise<NetworkResponse> => {
      const transport = this.transportFor(current)
      const carried: NetworkRequest = {
        ...current,
        transportHint: transport.id,
      }
      try {
        const response = await transport.request(carried)
        return this.tapResponse(carried, response)
      } catch (err) {
        if (transport === this.primary && this.shouldFallback(carried)) {
          const fb = await this.fallback!.request({
            ...carried,
            transportHint: this.fallback!.id,
          })
          fb.transport.fallbackUsed = true
          return this.tapResponse(carried, fb)
        }
        throw err
      }
    }

    // 3. Wrap the inner thunk in any `wrap()` policies (LIFO nesting:
    //    earlier policies become outer scopes). Each policy receives
    //    a `run(override?)` that re-fires the inner thunk with a
    //    (possibly modified) request — but does NOT re-run policies.
    const wrapped = this.policies.reduceRight<(req: NetworkRequest) => Promise<NetworkResponse>>(
      (inner, policy) => {
        if (!policy.wrap) return inner
        return (currentReq) => policy.wrap!(currentReq, (override) => inner(override ?? currentReq))
      },
      fire,
    )

    try {
      // 4. Run the wrapped chain. The outermost wrap (== first in
      //    registration order) sees `req`; each `wrap` decides whether
      //    to call the next layer with its own override.
      let response = await wrapped(req)

      // 5. Post-flight: `onResponse` policies run in LIFO order. Each
      //    may substitute the response (e.g. AuthRefreshPolicy swaps
      //    a 401 for a retried 200). The substitution becomes input
      //    to the next-outer policy.
      for (let i = this.policies.length - 1; i >= 0; i--) {
        const policy = this.policies[i]
        if (!policy?.onResponse) continue
        const out = await policy.onResponse(req, response, (next) => fire(next))
        if (out) response = out
      }

      this.notifyResponse(req, response)
      return response
    } catch (err) {
      this.notifyError(req, err)
      throw err
    }
  }

  /**
   * Resolve which transport handles `req` based on its `protocol`
   * field. Falls back to `primary` when no transport is registered
   * for the requested protocol — keeps callers safe when a policy
   * pins h3 but the client owner didn't register an h3 transport.
   */
  private transportFor(req: NetworkRequest): NetworkTransport {
    if (req.protocol) {
      const t = this.transports.get(req.protocol)
      if (t) return t
    }
    // Plaintext http:// can't be served by the h2c-prior-knowledge primary
    // transport (it hangs waiting for an HTTP/2 preface a plain HTTP/1.1 server
    // never sends). Route it to the HTTP/1.1 transport when one is configured.
    // An explicit protocol pin above still wins. `https://` is untouched.
    if (this.plaintextHttpTransport && isPlaintextHttp(req.url)) {
      return this.plaintextHttpTransport
    }
    return this.primary
  }

  preconnect(origin: string): Promise<void> | void {
    return this.primary.preconnect?.(origin)
  }

  async close(): Promise<void> {
    await Promise.all([this.primary.close?.(), this.fallback?.close?.()])
  }

  private shouldFallback(req: NetworkRequest): boolean {
    return Boolean(this.fallback && (this.allowFetchFallback || req.allowFetchFallback))
  }

  private tapResponse(req: NetworkRequest, response: NetworkResponse): NetworkResponse {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        reader ??= response.body.getReader()
        try {
          const { done, value } = await reader.read()
          if (done) {
            this.notifyEnd(req, response)
            controller.close()
            reader.releaseLock()
            reader = undefined
            return
          }
          if (value) {
            this.notifyChunk(req, value, response)
            controller.enqueue(value)
          }
        } catch (err) {
          this.notifyError(req, err)
          controller.error(err)
        }
      },
      cancel: async (reason) => {
        await reader?.cancel(reason)
        reader?.releaseLock()
        reader = undefined
      },
    })

    return new NetworkResponse({
      status: response.status,
      headers: response.headers,
      body,
      transport: response.transport,
    })
  }

  private notifyRequest(req: NetworkRequest): void {
    for (const observer of this.observers) observer.onRequest?.(req)
  }

  private notifyResponse(req: NetworkRequest, res: NetworkResponse): void {
    for (const observer of this.observers) observer.onResponse?.(req, res)
  }

  private notifyChunk(req: NetworkRequest, chunk: Uint8Array, res: NetworkResponse): void {
    for (const observer of this.observers) observer.onChunk?.(req, chunk, res)
  }

  private notifyEnd(req: NetworkRequest, res: NetworkResponse): void {
    for (const observer of this.observers) observer.onEnd?.(req, res)
  }

  private notifyError(req: NetworkRequest, err: unknown): void {
    for (const observer of this.observers) observer.onError?.(req, err)
  }
}

/** True for a cleartext `http://` URL (not `https://`). Malformed → false. */
export function isPlaintextHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:"
  } catch {
    return false
  }
}

/**
 * Build the process default client from environment transport settings.
 *
 * **Transport selection** — `MINIMAL_AGENT_TRANSPORT`:
 *   - `"test"`  : in-memory fake (test env only)
 *   - `"fetch"` : Bun fetch (HTTP/1.1) as primary, no fallback
 *   - anything else (default) : node:http2 primary, fetch fallback
 *
 * **HTTP/3 opt-in** — `MINIMAL_AGENT_HTTP3`:
 *   - `"off"` (default) : h3 transport not registered
 *   - `"opt"`           : h3 transport registered + opportunistic policy
 *                         (h3 only when origin's Alt-Svc says so)
 *   - `"force"`         : h3 transport registered + force-h3 policy
 *                         (h3 by default until origin proves unsupported)
 *
 * The h3 path only fires when an opportunistic decision (or an
 * explicit `req.protocol: "h3"`) routes a request to it — the
 * primary transport for normal requests stays h2.
 *
 * @returns Network client wired to the resolved transport stack.
 */
export function createDefaultNetworkClient(): NetworkClient {
  const requested = process.env.MINIMAL_AGENT_TRANSPORT?.trim().toLowerCase()
  if (requested === "test") {
    const testEnv = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
    if (!testEnv) throw new Error("MINIMAL_AGENT_TRANSPORT=test is only allowed in test")
    return new NetworkClient({ primary: new TestTransport() })
  }
  const usingHttp2Primary = requested !== "fetch"
  const primary = usingHttp2Primary ? new Http2Transport() : new FetchTransport()
  const fallback = usingHttp2Primary ? new FetchTransport() : undefined
  // Auto-route plaintext http:// to HTTP/1.1: the h2c-prior-knowledge primary
  // hangs against a plain HTTP/1.1 server (local LLM runtimes like LM Studio /
  // vLLM / MLX, or a cleartext proxy). Only meaningful when the primary is
  // http2; when the user already pinned fetch, the primary IS http/1.1.
  // Opt out with MINIMAL_AGENT_NO_PLAINTEXT_HTTP1=1 (e.g. an h2c-capable local
  // server you want to reach over HTTP/2). See isPlaintextHttp + transportFor.
  const plaintextOptOut = process.env.MINIMAL_AGENT_NO_PLAINTEXT_HTTP1 === "1"
  const plaintextHttpTransport =
    usingHttp2Primary && !plaintextOptOut ? new FetchTransport() : undefined

  // HTTP/3 — opt-in via env. Off by default while Bun's h3 client is
  // experimental (Bun ≥ 1.3.14) and few origins serve h3 anyway
  // (notably api.anthropic.com refuses QUIC as of May 2026).
  const h3Mode = process.env.MINIMAL_AGENT_HTTP3?.trim().toLowerCase() ?? "off"
  const transports = new Map<NetworkProtocol, NetworkTransport>()
  const policies: NetworkPolicy[] = []
  if (h3Mode === "opt" || h3Mode === "force") {
    transports.set("h3", new Http3Transport())
    policies.push(
      http3OpportunisticPolicy({
        cache: new Http3NegotiationCache(),
        mode: h3Mode,
      }),
    )
  } else if (h3Mode !== "off" && h3Mode !== "") {
    // Unknown value → treat as "off" but tell the user.
    process.stderr.write(
      `[network] MINIMAL_AGENT_HTTP3="${h3Mode}" unrecognized (expected off/opt/force); h3 disabled.\n`,
    )
  }

  return new NetworkClient({
    primary,
    fallback,
    allowFetchFallback: process.env.MINIMAL_AGENT_ALLOW_FETCH_FALLBACK === "1",
    transports,
    ...(plaintextHttpTransport ? { plaintextHttpTransport } : {}),
    policies,
    // Order matters slightly: net-dbg snapshots full traffic to disk for
    // post-hoc debugging; the activity observer only mutates an attached
    // StatusHandle (cheap, in-memory). Neither depends on the other.
    observers: [createNetDebugObserver(), networkActivityObserver],
  })
}

export const defaultNetworkClient = createDefaultNetworkClient()
