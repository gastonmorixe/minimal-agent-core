/**
 * Generic wire-surface codec contract.
 *
 * A {@link SurfaceCodec} exposes the reusable request/response codec for one
 * API surface, independent of any concrete provider endpoint. First-party
 * provider plugins register codecs for surfaces they are willing to make
 * available to the generic endpoint provider. The generic provider supplies the
 * endpoint and auth at runtime, then delegates request construction and stream
 * translation to the selected codec.
 *
 * @module llm/surface-codec
 */

import type { NetworkRequestInput, NetworkResponse } from "../net/types.ts"
import type { ModelRate, ModelView } from "../types/host-capabilities.ts"

import type { CanonicalEvent } from "./canonical-events.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { Capabilities } from "./capabilities.ts"
import type { ProviderAuth, RunContext } from "./provider-auth.ts"
import type { ProviderValidationResult } from "./provider-plugin.ts"
import type { TokenEstimator } from "./token-estimate.ts"

/** Input handed to a codec when building one HTTP request. */
export interface SurfaceBuildRequestInput {
  /** Canonical request to encode. */
  req: CanonicalRequest
  /** Resolved model entry, usually an ad-hoc generic endpoint model. */
  model: ModelView
  /** Runtime auth chosen by the generic provider. */
  auth: ProviderAuth
  /** Fully normalized URL to call. */
  endpoint: string
  /** Per-call adapter context from the host. */
  ctx: RunContext
}

/** Input handed to a codec when translating one successful HTTP response. */
export interface SurfaceTranslateInput {
  /** Response body stream from the network layer. */
  body: ReadableStream<Uint8Array>
  /** Full response wrapper, for codecs that need headers or status metadata. */
  response: NetworkResponse
  /** Original canonical request. */
  req: CanonicalRequest
  /** Resolved model entry used for this request. */
  model: ModelView
  /** Per-call adapter context from the host. */
  ctx: RunContext
}

/** Error returned by a codec's optional HTTP error classifier. */
export type SurfaceCodecError = Error & { streamErrorType?: string }

/**
 * Reusable wire implementation for one provider-defined API surface.
 *
 * The generic endpoint adapter owns the network call. A codec owns the
 * surface-specific request shape, validation, and stream translation.
 */
export interface SurfaceCodec {
  /** Surface id, matching model `surfaceId`, for example `openai-chat-completions`. */
  readonly surfaceId: string
  /** Human-friendly label for help text and diagnostics. */
  readonly displayName: string
  /** Default path appended when a user supplies only a base URL. */
  readonly defaultPath: string
  /** Defaults used when the generic provider registers an ad-hoc model. */
  readonly defaultCapabilities: Capabilities
  readonly defaultPricing: ModelRate
  readonly defaultTags?: ReadonlyArray<string>
  readonly estimateTokens?: TokenEstimator
  /** Optional endpoint normalizer. The generic provider supplies a safe default. */
  normalizeEndpoint?(endpoint: string, defaultPath: string): string
  /** Pure request validation for this surface. */
  validate(req: CanonicalRequest, model: ModelView): ProviderValidationResult
  /** Build the HTTP request input, including headers and serialized body. */
  buildRequest(input: SurfaceBuildRequestInput): NetworkRequestInput
  /** Translate a successful streaming response into canonical events. */
  translateStream(input: SurfaceTranslateInput): AsyncIterable<CanonicalEvent>
  /** Optional HTTP error classifier for non-2xx pre-stream failures. */
  classifyError?(status: number, body: string): SurfaceCodecError
  /** Optional response-header hook for quota/rate-limit caches. */
  onResponseHeaders?(headers: Headers): void
}

/** Setup-time registry facade handed to provider plugins. */
export interface SurfaceCodecRegistry {
  /** Add or replace a codec by `surfaceId`. */
  register(codec: SurfaceCodec): void
  /** Look up one registered codec. */
  find(surfaceId: string): SurfaceCodec | undefined
  /** List all registered codecs in registration order. */
  list(): SurfaceCodec[]
}
