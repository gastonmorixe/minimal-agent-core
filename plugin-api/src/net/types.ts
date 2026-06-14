/**
 * Network-client contract — the provider-neutral TYPE surface a plugin needs
 * to make HTTP calls through the host's shared transport, without importing
 * `src/network/index.ts`.
 *
 * Wave D (net seam): every provider adapter used to
 * `import { defaultNetworkClient, type NetworkClient } from "../../src/network/index.ts"`
 * for two things — the runtime singleton (an instrumented fetch facade) AND
 * the `NetworkClient` type to annotate it. The singleton is HOST STATE (it
 * carries process-wide observers, transport selection, and HTTP/3 policy), so
 * it STAYS in `src/network/` and the host threads it to adapters through the
 * context they already receive (`RunContext.networkClient`). The TYPE, by
 * contrast, is provider-neutral and pure, so it lives here in the leaf contract
 * package where both the host and the plugins can depend on it.
 *
 * These are faithful, type-only structural copies of the host's shapes in
 * `src/network/types.ts` + `src/network/client.ts` (the D-1 "leaf-safe
 * structural copy" pattern, same as `PluginLogger` / `PluginHost`). The host
 * keeps the runtime `NetworkClient` / `NetworkResponse` CLASSES as the single
 * source of truth; TypeScript's structural typing makes those real objects
 * satisfy the interfaces here, so the host hands its real
 * `defaultNetworkClient` into a package-typed `ctx.networkClient` without a
 * cast, and a plugin reads it back as a package-typed `NetworkClient`.
 *
 * @module net/types
 */

/** HTTP method verbs the network layer accepts. */
export type NetworkMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** Wire protocol a request can be pinned to / a response was served over. */
export type NetworkProtocol = "http/1.1" | "h2" | "h3" | "ws" | "webrtc"

/** Per-response transport diagnostics (which transport served it, reuse, fallback). */
export interface NetworkTransportInfo {
  id: string
  protocol?: NetworkProtocol
  origin?: string
  reused?: boolean
  fallbackUsed?: boolean
}

/** Opt-in body capture for diagnostics/replay. */
export interface NetworkCaptureOptions {
  requestBody?: string | null
  responseBody?: boolean
}

/**
 * A single outbound request, provider-neutral. Structurally identical to the
 * host's `NetworkRequest`; adapters build the {@link NetworkRequestInput}
 * subset (no `id` / `transportHint`, those are host-assigned).
 */
export interface NetworkRequest {
  id: string
  label: string
  method: NetworkMethod
  url: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  signal?: AbortSignal
  timeoutMs?: number
  allowFetchFallback?: boolean
  capture?: NetworkCaptureOptions
  transportHint?: string
  /** Optional per-request protocol pin. Unset lets the host negotiate. */
  protocol?: NetworkProtocol
  /** Free-form labels a host network policy can match on. */
  policyTags?: ReadonlyArray<string>
}

/**
 * The argument shape for {@link NetworkClient.request}: a {@link NetworkRequest}
 * minus the host-assigned `id` / `transportHint` (the host fills those in). An
 * `id` may be supplied to correlate logs but is optional.
 */
export type NetworkRequestInput = Omit<NetworkRequest, "id" | "transportHint"> & {
  id?: string
}

/**
 * Response wrapper returned by {@link NetworkClient.request}. The host's
 * `NetworkResponse` is a concrete class; this is its public structural shape so
 * a plugin can read `ok` / `status` / `headers` / `body` and call `text()` /
 * `json()` without importing the class from `src/`.
 */
export interface NetworkResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array>
  readonly transport: NetworkTransportInfo
  /** `true` when `status` is in `[200, 300)`. */
  readonly ok: boolean
  /** Drain the body as a UTF-8 string. */
  text(): Promise<string>
  /** Drain the body and JSON-parse it. */
  json<T = unknown>(): Promise<T>
}

/**
 * Transport-agnostic network client — the contract a plugin adapter consumes
 * via `ctx.networkClient`. The host's concrete `NetworkClient` (with observers,
 * fallback, and HTTP/3 policy) is structurally assignable to this; a plugin
 * only ever needs {@link NetworkClient.request}.
 */
export interface NetworkClient {
  /** Fire one request through the host's transport stack. */
  request(input: NetworkRequestInput): Promise<NetworkResponse>
  /** Optional: warm a connection to `origin` ahead of the first request. */
  preconnect?(origin: string): Promise<void> | void
  /** Optional: release transport resources. */
  close?(): Promise<void>
}
