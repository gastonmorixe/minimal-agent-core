/**
 * The `ProviderAdapter` port — the single interface every provider
 * (Anthropic, OpenAI Chat, OpenAI Responses, future Realtime) implements.
 *
 * The agent loop only talks to adapters via this port through the
 * top-level `run()` orchestrator. Nothing in the agent imports
 * provider-specific code; the model registry resolves
 * `request.modelId` to a `ModelEntry`, the provider registry resolves
 * `modelEntry.providerId` to an adapter, and `run()` calls
 * `adapter.run(req, model, ctx)`.
 *
 * @module llm/provider
 */

import type { CanonicalEvent, CanonicalUsage } from "./canonical-events.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { CapabilityViolation } from "./errors.ts"
import type { ModelEntry } from "./model-registry.ts"

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Provider-neutral auth descriptor.
 *
 * - `oauth`: OAuth bearer with optional refresh callback (Anthropic).
 *   The shared transport handles the 401-keychain-race fix and forwards
 *   refreshed tokens back into the same request without restarting
 *   the conversation.
 * - `api-key`: header-token auth (OpenAI, Anthropic API key,
 *   Anthropic Bedrock). No refresh.
 * - `custom`: arbitrary header bag for self-hosted gateways.
 */
export type ProviderAuth =
  | {
      kind: "oauth"
      token: string
      refresh?: () => Promise<{ token: string }>
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
}

export interface DebugSink {
  header(line: string): void
  kv(key: string, value: string): void
  headers(map: Record<string, string>): void
  body(value: unknown): void
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean
  errors: CapabilityViolation[]
  /**
   * Optional degraded request the caller can opt into instead of
   * failing outright. E.g. "this model doesn't support adaptive
   * thinking; here is the same request with thinking off".
   */
  degrade?: CanonicalRequest
}

// ---------------------------------------------------------------------------
// Surface ids
// ---------------------------------------------------------------------------

/**
 * Names of the API surfaces an adapter can speak. Multiple per
 * provider is the norm (OpenAI exposes both Chat and Responses).
 *
 * Adapters dispatch by `ModelEntry.surfaceId`.
 */
export type SurfaceId =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses"
  | "openai-realtime"
  | "custom"

// ---------------------------------------------------------------------------
// Adapter port
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  /** Registry id (e.g. `"anthropic"`, `"openai"`). */
  readonly id: string
  /** Human-friendly name for diagnostics. */
  readonly displayName: string
  /** Surfaces this adapter implements. */
  readonly surfaces: ReadonlyArray<SurfaceId>

  /**
   * Validate that the request can be served by this model + provider
   * combo. Pure : no network. Called by `run()` before dispatch and
   * usable standalone (the REPL pre-flights edits-mid-conversation).
   */
  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult

  /**
   * Stream the request. Yields canonical events in the ordering
   * invariant described on `CanonicalEvent`. Throws on fatal errors;
   * yields `StreamErrorEvent` on retryable mid-stream errors.
   */
  run(req: CanonicalRequest, model: ModelEntry, ctx: RunContext): AsyncIterable<CanonicalEvent>

  /**
   * Optional: enumerate models the authenticated principal can see.
   * Returns `ModelEntry` records ready to register.
   */
  listModels?(ctx: RunContext): Promise<ModelEntry[]>

  /** Optional cheap health probe. */
  ping?(ctx: RunContext): Promise<boolean>
}
