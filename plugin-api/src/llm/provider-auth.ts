/**
 * Provider-neutral run-time contract slices: auth descriptor, per-call run
 * context, media-progress event, and the debug sink.
 *
 * Wave D-1 split: these types used to live in `src/llm/provider.ts`. They carry
 * NO provider fingerprint (no surface-id string unions, no model ids), so they
 * are safe to live in the leaf contract package where both the host and the
 * plugins can depend on them. The token-bearing remainder of `provider.ts`
 * (`SurfaceId`, the `ProviderAdapter` port, validation/preflight types) stays
 * in `src/` and is re-exported alongside these for back-compat.
 *
 * `RunContext` references {@link MediaProgress} (declared here) and the
 * canonical {@link CanonicalUsage} (imported from the canonical-events module
 * in this same package), so the whole graph resolves inside the leaf without
 * reaching into `src/`.
 *
 * @module llm/provider-auth
 */

import type { CanonicalUsage } from "./canonical-events.ts"

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Provider-neutral auth descriptor.
 *
 * - `oauth`: OAuth bearer with optional refresh callback. The shared transport
 *   handles the 401 multi-process refresh race and forwards refreshed tokens
 *   back into the same request without restarting the conversation.
 * - `api-key`: header-token auth. No refresh.
 * - `custom`: arbitrary header bag for self-hosted gateways.
 */
export type ProviderAuth =
  | {
      kind: "oauth"
      token: string
      refresh?: () => Promise<{ token: string }>
      /**
       * Optional provider-owned request headers derived from stored auth
       * metadata. The host carries these but does not interpret them.
       */
      headers?: Record<string, string>
      /**
       * Optional provider-owned runtime API base URL for auth modes whose
       * endpoint differs from API-key auth (for example plan-auth backends).
       */
      baseUrl?: string
    }
  | {
      kind: "api-key"
      key: string
      organization?: string
      project?: string
    }
  | {
      kind: "custom"
      headers: Record<string, string>
    }

// ---------------------------------------------------------------------------
// Run context (transport + observability)
// ---------------------------------------------------------------------------

/**
 * Per-call context handed to every adapter. Carries the network client
 * (so tests can swap it), session id, auth, and observation hooks.
 *
 * Kept deliberately small; everything provider-specific lives on the
 * `CanonicalRequest.vendor.*` namespace, not here.
 */
export interface RunContext {
  auth: ProviderAuth
  sessionId: string
  /**
   * Network client; defaults to the global one. Tests inject mocks.
   * The shape is intentionally not imported here to keep this file
   * dependency-light : adapters import what they need.
   */
  networkClient?: unknown
  /**
   * Debug sink. When provided, adapters log request/response metadata.
   * No-op by default.
   */
  debug?: DebugSink
  /**
   * Fired on every usage snapshot the provider reports during a stream
   * (initial + cumulative deltas + final). Adapter computes USD cost
   * via the registry's pricing table.
   */
  onUsage?: (usage: CanonicalUsage, costUSD: number) => void
  /**
   * Fired by `ProviderAdapter.prepareMedia` as an async media step
   * (upload / transcode) progresses. The agent renders a transient progress
   * line above the input prompt. No-op by default.
   */
  onMediaProgress?: (progress: MediaProgress) => void
}

/**
 * Progress event for an in-flight async media step (e.g. a Files API upload).
 * Emitted via {@link RunContext.onMediaProgress}.
 */
export interface MediaProgress {
  /** The media item id the progress refers to. */
  mediaId: string
  phase: "reading" | "uploading" | "processing"
  /** Completion in `[0,1]` when known; `null` for an indeterminate spinner. */
  fraction: number | null
  bytesDone?: number
  bytesTotal?: number
}

export interface DebugSink {
  header(line: string): void
  kv(key: string, value: string): void
  headers(map: Record<string, string>): void
  body(value: unknown): void
}
