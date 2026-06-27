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

import type { MediaLimits } from "../media/limits.ts"
import type { MediaItem, PreparedMedia } from "../media/types.ts"
import type { SubagentModelRecommendation } from "../plugins/types.ts"

import type { CanonicalEvent } from "./canonical-events.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { CapabilityViolation } from "./errors.ts"
import type { ModelEntry } from "./model-registry.ts"

// ---------------------------------------------------------------------------
// Auth + run context (Wave D-1: MOVED to the leaf contract package)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral run-time contract slice — `ProviderAuth`, `RunContext`,
 * `MediaProgress`, `DebugSink` — now lives in
 * `@minimal-agent/plugin-api/llm/provider-auth`. It carries no provider
 * fingerprint, so it is safe in the leaf package both core and plugins depend
 * on. This re-export keeps `src/llm/provider.ts` the single import surface for
 * core (and any not-yet-swept plugin): the `ProviderAdapter` port +
 * validation/preflight stay here in `src/`. The port names no provider.
 */
import type {
  DebugSink,
  MediaProgress,
  ProviderAuth,
  RunContext,
} from "@minimal-agent/plugin-api/llm/provider-auth"

export type { DebugSink, MediaProgress, ProviderAuth, RunContext }

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
// Preflight (pre-dispatch issues that need user decision)
// ---------------------------------------------------------------------------

/**
 * One mutually-exclusive choice the user can pick to resolve a
 * {@link PreflightIssue}. Provider-defined `id` values are passed back
 * into {@link ProviderAdapter.applyResolution} verbatim, so providers
 * are free to use any stable string (e.g. `"strip"`, `"switch:claude-opus-4-7"`).
 *
 * UI hints:
 * - `label`: short button caption.
 * - `description`: optional one-line explanation rendered beneath the label.
 * - `isDefault`: at most one per issue, used as the initial selection.
 * - `destructive`: true if picking this would lose state (e.g. strip context);
 *   the modal MAY render a warning ornament.
 */
export interface PreflightOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
  destructive?: boolean
}

/**
 * One issue the provider detected that requires user resolution BEFORE
 * the network call. Multiple issues per request are allowed; the agent
 * asks the user about each one in declaration order.
 *
 * `code` is provider-defined and stable across versions, so callers can
 * special-case telemetry or auto-resolution per issue. Example codes:
 *
 * - `"anthropic.thinking-model-mismatch"` — the history contains
 *   thinking-block signatures from a different model than the one the
 *   request is targeting (e.g. fork chain that switched models). The
 *   Anthropic server rejects the request without intervention.
 */
export interface PreflightIssue {
  code: string
  /** One-line title shown at the top of the modal. */
  title: string
  /**
   * Body paragraph(s). The host renderer is expected to wrap to the
   * modal's available width. Use `\n` to force a paragraph break.
   */
  detail: string
  /** Mutually-exclusive resolutions the user picks from. */
  options: PreflightOption[]
}

/**
 * Result of applying a user's resolution to a {@link PreflightIssue}.
 *
 * - `"modify-request"`: the provider returns a modified request to send
 *   in place of the original. Optionally signals `adoptModelId` to ask
 *   the agent to update its own model id for future turns too (e.g.
 *   when the user picks "switch back to the original model").
 * - `"cancel"`: the user declined to proceed; the agent should abort
 *   the current send (typically by throwing an AbortError).
 */
export type PreflightResolution =
  | {
      kind: "modify-request"
      request: CanonicalRequest
      /** Optional model id the agent should adopt for subsequent turns. */
      adoptModelId?: string
    }
  | { kind: "cancel" }

// ---------------------------------------------------------------------------
// Surface ids
// ---------------------------------------------------------------------------

/**
 * Name of an API surface an adapter can speak. A provider may serve several
 * surfaces (a chat-completions surface and a responses surface, say); each
 * model declares the one it uses via `ModelEntry.surfaceId`.
 *
 * Open by design: the surface vocabulary is provider-defined, so this is an
 * opaque string the core never compares against a literal. Each provider
 * plugin owns its own surface names (e.g. `"<vendor>-messages"`); the adapter
 * dispatches on its own values internally.
 */
export type SurfaceId = string

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
   * Optional: scan the request for issues that need user resolution
   * BEFORE the network call. Pure : no network, no I/O. Returns an
   * empty array (or undefined) for a clean request.
   *
   * The agent invokes this on every send (or once per model change,
   * provider's choice via cheap fingerprint inside the function).
   * When any issue is returned, the agent opens a host-provided modal
   * (one per issue) and routes the chosen option id back to
   * {@link applyResolution}.
   *
   * Provider-specific: Anthropic detects model-signature mismatches
   * from session-fork chains so the user can pick "strip stale thinking
   * blocks", "switch back to the original model", or "cancel" instead
   * of hitting the API and getting a 400. Other providers have no
   * issues to surface today and may leave this undefined.
   */
  preflight?(req: CanonicalRequest, model: ModelEntry): PreflightIssue[]

  /**
   * Optional: apply the user's resolution to an issue raised by
   * {@link preflight}. Receives the original request, the issue code,
   * and the option id chosen by the user. Returns the modified request
   * to send, or a cancel signal. Must be defined when `preflight()`
   * returns any issues.
   */
  applyResolution?(req: CanonicalRequest, issueCode: string, optionId: string): PreflightResolution

  /**
   * Optional: enumerate models the authenticated principal can see.
   * Returns `ModelEntry` records ready to register.
   */
  listModels?(ctx: RunContext): Promise<ModelEntry[]>

  /**
   * Optional: recommend which of THIS provider's models + settings suit each
   * abstract sub-agent role (`"scout" | "balanced" | "deep"`, an open
   * vocabulary). The delegation layer speaks only in roles and never names a
   * vendor SKU; the provider owns the role→model mapping and the model-specific
   * knobs (effort, thinking). Pure: no network, reads the provider's own
   * registered models. The host calls this for the ACTIVE provider only and
   * surfaces it to plugins via `ctx.recommendSubagentModels` (a plugin never
   * imports a provider). Omit it (or return `[]`) to let callers fall back to
   * the lead's own model.
   *
   * Implementations MUST recommend only models this provider actually serves
   * (never another vendor's SKU), so a worker spawned from a recommendation
   * stays on the user's current provider + account.
   */
  recommendSubagentModels?(): SubagentModelRecommendation[]

  /** Optional cheap health probe. */
  ping?(ctx: RunContext): Promise<boolean>

  /**
   * Optional: the media byte/format/dimension budget this model accepts, as
   * data. Returned to the agent so attach-time + submit-time validation
   * (`checkMedia`) can reject oversize / unsupported media with a warning
   * before the network call. Undefined ⇒ no media (text-only).
   */
  mediaLimits?(model: ModelEntry): MediaLimits

  /**
   * Optional async prepare for ONE attached item: probe and/or upload it to the
   * provider's file store, returning the canonical source to embed. Reports
   * progress via {@link RunContext.onMediaProgress}. MUST be idempotent per
   * `(this.id, item.id)` and cache into `item.prepared[this.id]`. Adapters that
   * inline base64 can skip uploading and just build a base64 source here.
   */
  prepareMedia?(item: MediaItem, model: ModelEntry, ctx: RunContext): Promise<PreparedMedia>
}
