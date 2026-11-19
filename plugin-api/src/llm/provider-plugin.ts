/**
 * Provider-plugin contract types + the pure default system-prompt resolver.
 *
 * A `ProviderPlugin` is a self-describing unit that contributes ONE provider
 * (its `ProviderAdapter` + model catalog) to the canonical registries when
 * activated. It is the seam the composition root uses to wire providers, so the
 * agent entrypoint never names a provider by hand.
 *
 * This is the SAME shape each `plugins/llm-<id>/` package exports. The provider
 * loader scans for a `provider.json`, dynamically imports the declared
 * `ProviderPlugin`, and registers it, so the core never imports a provider by
 * name.
 *
 * Wave D-1 split: the TYPE surface + the pure {@link neutralSystemPrompt}
 * helper moved here into the leaf contract package (provider-neutral, no host
 * state) so plugins can depend on them without reaching into `src/`. The
 * stateful registry (`registerProviderPlugin` / `listProviderPlugins` /
 * `findProviderPlugin` / `activateProviderPlugins` / `clearProviderPlugins`,
 * backed by a module-level `Map`) is host state and STAYS in
 * `src/llm/provider-plugin.ts`, which re-exports these types for back-compat.
 *
 * @module llm/provider-plugin
 */

import type { ModelRate, ModelView } from "../types/host-capabilities.ts"
import type { SubagentModelRecommendation, UtilityModelRecommendation } from "../types/plugin.ts"

import type { Capabilities } from "./capabilities.ts"
import type { CanonicalEvent } from "./canonical-events.ts"
import type { AudioSource, FileSource, ImageSource, VideoSource } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { CapabilityViolation } from "./errors.ts"
import type { ProviderAuth, RunContext } from "./provider-auth.ts"
import type { SurfaceCodecRegistry } from "./surface-codec.ts"
import type { TokenEstimator } from "./token-estimate.ts"

/**
 * Context handed to a plugin's optional {@link ProviderPlugin.onStartupProbe}.
 * Provider-neutral: the composition root builds it once and passes it to
 * every registered plugin, so the entrypoint never special-cases a provider.
 */
export interface ProviderStartupContext {
  /** Resolved auth in provider-neutral form. */
  auth: ProviderAuth
  /** Selected model id, normalized (no `[1m]` / `[2m]` context suffix). */
  modelId: string
}

/**
 * One live-catalog row returned by {@link ProviderPlugin.listLiveModels}.
 * Provider-neutral projection of "what the server says exists right now".
 */
export interface LiveModelRow {
  /** Wire model id (plus any client-side variant suffix the plugin adds). */
  id: string
  /** Human-friendly name, when the server provides one. */
  displayName?: string
  /** ISO date (YYYY-MM-DD) the server reports for the model, if any. */
  createdAt?: string
}

/**
 * One beta/feature-flag descriptor returned by
 * {@link ProviderPlugin.listBetaFlags}. Provider-neutral projection of "what
 * protocol opt-in flags this provider can send and when", for the
 * `--list-flags` command. The `id` is the wire flag value; the rest is
 * human-facing documentation.
 */
export interface BetaFlagInfo {
  /** The flag value sent on the wire (e.g. in a provider-specific header). */
  id: string
  /** What the flag enables. */
  description: string
  /** Where the flag was sourced from (reverse-engineering provenance). */
  source?: string
  /** The condition under which the provider attaches the flag. */
  condition?: string
}

// ---------------------------------------------------------------------------
// Setup-time model registration (Wave D net/registry seam)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral spec for registering ONE model into the host registry, the
 * input shape a provider plugin hands to {@link ModelRegistrar.register}.
 *
 * This is the registration counterpart of the read-only `ModelView`: it adds
 * the two fields a registration needs that a read view omits — the optional
 * {@link TokenEstimator} and the per-cloud `vendorIds` map. `surfaceId` is a
 * plain `string` here (the host's `SurfaceId` is a token-bearing union that
 * stays in `src/`); the host's registrar narrows it when it forwards the spec
 * to the real `registerModel`. The host's real `ModelEntry` is structurally
 * compatible, so a plugin can build this spec without importing `src/`.
 */
export interface ProviderModelSpec {
  id: string
  aliases?: ReadonlyArray<string>
  providerId: string
  surfaceId: string
  displayName: string
  knowledgeCutoff?: string
  tags?: ReadonlyArray<string>
  capabilities: Capabilities
  pricing: ModelRate
  /** Per-cloud-vendor model ids (e.g. `{ firstParty: "gpt-5.5" }`). */
  vendorIds?: Readonly<Record<string, string>>
  /** Optional token estimator for this model's tokenizer family. */
  estimateTokens?: TokenEstimator
}

/**
 * Setup-time write access to the host model registry. The host builds this and
 * passes it to {@link ProviderPlugin.register} via {@link ProviderSetupContext},
 * so a provider plugin contributes its catalog by calling `ctx.models.register`
 * instead of importing `registerModel` / `setDefaultModelId` from `src/`.
 * Idempotent; last-write-wins per id (mirrors the registry's own contract).
 */
export interface ModelRegistrar {
  /** Add or replace a model entry. Throws on id/alias collision. */
  register(spec: ProviderModelSpec): void
  /** Declare the default model id a no-model session should boot with. */
  setDefault(id: string | null): void
}

/**
 * Validation verdict a {@link ProviderAdapterView.validate} returns, the
 * provider-neutral mirror of the host's `ValidationResult`. The host's real
 * shape is structurally identical, so the host narrows this back to its own
 * `ValidationResult` when it forwards a registered adapter.
 */
export interface ProviderValidationResult {
  ok: boolean
  errors: CapabilityViolation[]
  /** Optional degraded request the caller can opt into instead of failing. */
  degrade?: CanonicalRequest
}

/**
 * Provider-neutral projection of the host's `ProviderAdapter` port — the slice
 * a plugin actually implements, expressed entirely in leaf types so a provider
 * plugin can declare its adapter without importing `src/llm/provider.ts`.
 *
 * `surfaces` is `ReadonlyArray<string>` here (the host's `SurfaceId` is a
 * token-bearing union that stays in `src/`); `validate`/`run` take the read-only
 * {@link ModelView} rather than the host's richer `ModelEntry`. The host's real
 * `ProviderAdapter` is structurally compatible with this view, and the host's
 * registrar narrows a registered adapter back to the token-bearing port as it
 * forwards to the real `registerProvider` (the host is allowed to name surfaces;
 * the contract package is not). Optional host-only hooks (`preflight`,
 * `applyResolution`, `listModels`, `ping`) are omitted from the view — a provider that needs them implements the host port
 * directly; OpenAI-compatible providers like this do not.
 */
/**
 * Input for optional remote history compaction. Mirrors the host
 * `CompactInput` (plugin-api leaf slice).
 */
export interface CompactInput {
  req: CanonicalRequest
}

/** Result of a successful remote compact call. */
export interface CompactResult {
  replacementMessages: Array<{
    role: "user" | "assistant" | "system"
    content: string
  }>
  kind: "remote" | "local"
  rawOutput?: unknown[]
}

// ---------------------------------------------------------------------------
// Media hooks (leaf mirror of the host media types)
// ---------------------------------------------------------------------------

/**
 * The byte/format/dimension budget a (provider, model) accepts, as data. The
 * host `src/media/limits.ts` re-exports this type, so there is one definition.
 */
export interface MediaLimits {
  /** Mime types the model accepts, e.g. `image/jpeg`. Case-sensitive, lowercase. */
  acceptedMimeTypes: ReadonlySet<string>
  /** Hard cap for a single item (on the base64-encoded size). */
  maxBytesPerItem: number
  /** Cap for the whole request payload (sum of attached media). */
  maxRequestBytes: number
  /** Max attachments in one request. */
  maxItemsPerRequest: number
  /** Longest edge in px; `null` to skip the check. */
  maxDimension: number | null
}

/**
 * The canonical source a provider prepared for one media item (inline base64
 * or an uploaded `file_id`), plus the bytes it sent.
 */
export interface PreparedMedia {
  source: ImageSource | AudioSource | FileSource | VideoSource
  bytesSent: number
}

/**
 * Read-only leaf view of the host `MediaItem` that
 * {@link ProviderAdapterView.prepareMedia} receives. The host item is a
 * structural superset.
 */
export interface MediaItemView {
  /** 8-hex short id, content-addressed by sha256(bytes). */
  readonly id: string
  readonly kind: "image" | "audio" | "video" | "document"
  /** Canonical mime sniffed from magic bytes or typed from the extension. */
  readonly mimeType: string
  /** Absolute path for dropped / typed paths; `null` for pasted bytes. */
  readonly path: string | null
  readonly sizeBytes: number
  /** sha256 hex of the bytes. */
  readonly sha256: string
  readonly dimensions: { width: number; height: number } | null
  readonly durationSec: number | null
  /** Lazily read the bytes. */
  bytes(): Promise<Uint8Array>
  /** Per-provider prepared handles, keyed by provider id. */
  prepared: Record<string, PreparedMedia>
}

export interface ProviderAdapterView {
  /** Registry id, matching `ProviderPlugin.id` and `ModelView.providerId`. */
  readonly id: string
  /** Human-friendly name for diagnostics. */
  readonly displayName: string
  /** API surface names this adapter speaks (e.g. `"openai-chat-completions"`). */
  readonly surfaces: ReadonlyArray<string>
  /** Pure capability check, no network. Called before dispatch. */
  validate(req: CanonicalRequest, model: ModelView): ProviderValidationResult
  /** Stream the request, yielding canonical events. */
  run(req: CanonicalRequest, model: ModelView, ctx: RunContext): AsyncIterable<CanonicalEvent>
  /** Optional per-role sub-agent model recommendations from this provider's own catalog. */
  recommendSubagentModels?(): SubagentModelRecommendation[]
  /**
   * Optional: this provider's cheap utility model for short side calls
   * (titles). Pure: no network. `undefined` ⇒ the host uses the `utility`
   * model tag, then nothing.
   */
  recommendUtilityModel?(): UtilityModelRecommendation | undefined
  /**
   * Optional: the media budget this model accepts, as data. The host uses it
   * for attach-time and submit-time validation (`checkMedia`). The accepted
   * types should match the model's {@link Capabilities.inputMimeTypes}.
   * Undefined ⇒ the host uses its neutral conservative floor.
   */
  mediaLimits?(model: ModelView): MediaLimits
  /**
   * Optional async prepare for ONE attached item: probe and/or upload it, and
   * return the canonical source to embed. MUST be idempotent per
   * `(this.id, item.id)` and cache into `item.prepared[this.id]`.
   */
  prepareMedia?(item: MediaItemView, model: ModelView, ctx: RunContext): Promise<PreparedMedia>
  /**
   * Optional remote history compaction (provider-owned unary endpoint).
   * Undefined ⇒ host falls back to local summarization/prune.
   */
  compact?(
    input: CompactInput,
    model: ModelView,
    ctx: RunContext,
  ): Promise<CompactResult>
}

/**
 * Setup-time write access to the host provider registry. The host builds this
 * and passes it to {@link ProviderPlugin.register} via {@link ProviderSetupContext},
 * so a provider plugin contributes its adapter by calling `ctx.providers.register`
 * instead of importing `registerProvider` from `src/`. Idempotent;
 * last-registration-wins per id (mirrors the registry's own contract).
 */
export interface ProviderAdapterRegistrar {
  /** Add or replace a provider adapter under its `id`. */
  register(adapter: ProviderAdapterView): void
}

/**
 * Context handed to {@link ProviderPlugin.register} at activation. Carries the
 * host capabilities a provider needs at LOAD time: the model
 * {@link ModelRegistrar} and the provider-adapter {@link ProviderAdapterRegistrar}.
 * It is the provider-loader analogue of the TUI `ctx.host`: the seam that lets a
 * provider plugin reach host state (the model + provider registries) without a
 * `src/` import.
 *
 * `register()` keeps a no-arg call path for back-compat (a plugin that hasn't
 * adopted the seam, or a host that hasn't wired it, still works); a plugin that
 * HAS adopted it reads `ctx?.models` / `ctx?.providers` and falls back to its
 * own wiring when the context is absent.
 *
 * `providers` is optional so older hosts that build a `{ models }`-only context
 * stay valid; a plugin that needs it must defensively check
 * (`if (!ctx?.providers) return`) before use.
 */
export interface ProviderSetupContext {
  /** Setup-time model-registry writer (the `models:register` capability). */
  models: ModelRegistrar
  /** Setup-time provider-adapter-registry writer (the `providers:register` capability). */
  providers?: ProviderAdapterRegistrar
  /** Setup-time generic wire-surface codec registry writer. */
  surfaceCodecs?: SurfaceCodecRegistry
}

// ---------------------------------------------------------------------------
// System-prompt resolution (Strategy + Template Method)
// ---------------------------------------------------------------------------

/**
 * Minimal tri-state override for a single prompt part, mirrored from
 * `src/llm/system-prompt-overrides.ts` so the plugin-api contract stays
 * dependency-free. Only `replace` and `omit` are meaningful at the provider
 * seam; `default` is never passed.
 */
export type ProviderPromptPartOverride =
  | { readonly kind: "replace"; readonly text: string }
  | { readonly kind: "omit" }

/**
 * One system-prompt block. Structurally identical to `headers.SystemBlock`,
 * but declared here so the provider port carries no dependency on the
 * Anthropic-flavored `headers.ts` module (DIP: the contract owns its types).
 */
export interface SystemPromptBlock {
  type: "text"
  text: string
  cache_control?: {
    type: "ephemeral"
    ttl?: "5m" | "1h"
    scope?: "global"
  }
}

/**
 * Input to {@link ProviderPlugin.resolveSystemPrompt}.
 *
 * The agent builds the provider-NEUTRAL skeleton (a default `identity` line +
 * the `body` blocks: instructions, then optional session context) and hands it
 * to the provider, which returns the FINAL wire blocks. This is the seam that
 * lets each provider own its preamble:
 *
 *   - An OAuth (plan auth) provider prepends its mandatory billing header and
 *     the exact identity its server validates, dropping the neutral identity.
 *   - An api-key / generic provider keeps the neutral identity and adds nothing
 *     (or whatever it needs).
 *
 * A provider that doesn't implement the hook gets {@link neutralSystemPrompt}.
 */
export interface SystemPromptContext {
  /** The default neutral identity line (`"You are Minimal Agent, …"`). */
  identity: string
  /** Body blocks after the identity: `[instructions(cached), sessionContext?]`. */
  body: SystemPromptBlock[]
  /** Auth kind the request will use, so the provider can vary its preamble. */
  authKind: ProviderAuth["kind"]
  /** Normalized model id (no `[1m]`/`[2m]` suffix). */
  modelId: string
  /** Optional provider preamble override, gated by unsafe flag at startup. */
  providerPreambleOverride?: ProviderPromptPartOverride
}

/**
 * Default resolution when a provider declares no {@link ProviderPlugin.resolveSystemPrompt}:
 * the neutral identity followed by the agent's body blocks, unchanged.
 */
export function neutralSystemPrompt(ctx: SystemPromptContext): SystemPromptBlock[] {
  return [{ type: "text", text: ctx.identity }, ...ctx.body]
}

// ---------------------------------------------------------------------------
// Session metadata (quota / usage windows) — provider-neutral DTO
// ---------------------------------------------------------------------------

/**
 * One usage/quota window, provider-neutral. A provider might surface `"5h"` /
 * `"7d"` plan windows; another might surface `"rpm"` / `"tpm"` or nothing.
 * The renderer treats `id` as the display label and never parses it.
 */
export interface QuotaWindow {
  /** Provider-defined id, also used verbatim as the short display label. */
  id: string
  /** Utilization fraction in `[0, 1]`. */
  utilization: number
  /** Epoch milliseconds when the window resets, if the provider reports it. */
  resetAtMs?: number
}

/** A set of quota/usage windows. Empty `windows` ⇒ provider has no quota concept. */
export interface QuotaSnapshot {
  windows: QuotaWindow[]
  /**
   * Optional overage state, provider-neutral. `active: true` ⇒ the provider's
   * overage allowance is engaged/permitted; `active: false` ⇒ overage is off.
   * Absent ⇒ the provider has no overage concept (or didn't report it this
   * tick). Overage has no utilization, so it is NOT a {@link QuotaWindow}; the
   * footer surfaces only the "off" readout, and only when the user opts in.
   */
  overage?: { active: boolean }
}

/**
 * Provider-neutral session metadata for the status bar. Every field is
 * optional so a minimal provider can return `{}` (or core can synthesize a
 * context-only view from the registry). The agent renders from THIS, never
 * from a provider's wire shape.
 */
export interface ProviderSessionInfo {
  /** Model context window in tokens (for the context-usage segment). */
  contextWindow?: number
  /** Compact provider-model label, e.g. `"anth-4.8"`, `"oai-5.5"`. */
  modelLabel?: string
  /** Plan / rate-limit windows. Absent or empty ⇒ no quota segment. */
  quota?: QuotaSnapshot
}

/** Context for {@link ProviderPlugin.fetchSessionInfo}. */
export interface ProviderSessionContext {
  /** Normalized model id (no `[1m]`/`[2m]` suffix). */
  modelId: string
  /**
   * Cancellation forwarded to any network probe. The live-area scheduler's
   * per-slot timeout drives this, so a stuck probe is torn down (and the
   * shared transport's abort escalation evicts a wedged session).
   */
  signal?: AbortSignal
  /** Network client to reuse (defaults to the shared one). Untyped to keep this port dependency-light. */
  networkClient?: unknown
}

/**
 * Provider-neutral account plan view for one stored credential, returned by
 * {@link ProviderPlugin.fetchAccountPlan}. Every field is optional: a
 * provider fills what its account endpoints report. Hosts render the fields
 * as given and never parse provider tier codes. Never holds secrets.
 */
export interface AccountPlanInfo {
  /** Display-safe account identity. */
  accountId?: string
  email?: string
  /** Organization or workspace the credential acts in. */
  organizationId?: string
  organizationName?: string
  /** The member's role in that organization (provider wording). */
  role?: string
  /** One-line human plan summary, e.g. `"Team · Max 5x seat"`. */
  plan?: string
  /**
   * Whether the credential has a paid plan or seat. `false` means the
   * provider reports base access only. Absent means unknown.
   */
  hasPlan?: boolean
  /** Usage windows. `utilization` is a fraction in `[0, 1]`. */
  windows?: readonly QuotaWindow[]
  /** Overage (pay past the plan limit) state, when the provider reports it. */
  overage?: { enabled: boolean; reason?: string }
  /** Raw provider fields for detail views, rendered verbatim and in order. */
  details?: readonly AuthCredentialDetail[]
}

/** Context for {@link ProviderPlugin.fetchAccountPlan}. */
export interface AccountPlanContext {
  /** Cancellation for the account requests. */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Login (OAuth PKCE flow) — provider-owned Strategy
// ---------------------------------------------------------------------------

/** Provider-owned OAuth authorization settings for the host's PKCE flow. */
export interface OAuthLoginConfig {
  /** OAuth client id to send to the authorize and token endpoints. */
  clientId: string
  /** Browser URL for the authorization-code request. */
  authorizeUrl: string
  /** Token endpoint URL for the authorization-code exchange. */
  tokenUrl: string
  /** Redirect URI used by the manual paste-back page. */
  redirectUri: string
  /** Scopes requested at login time, in provider-defined order. */
  scopes: readonly string[]
  /** Additional authorize-query parameters owned by the provider. */
  authorizeParams?: Readonly<Record<string, string>>
  /** Query parameter name used for optional email pre-fill. */
  loginHintParam?: string
  /** Token-exchange body encoding. Defaults to JSON for legacy providers. */
  tokenRequestEncoding?: "json" | "form"
  /** Whether the token exchange should include the OAuth state value. Defaults to true. */
  tokenRequestIncludesState?: boolean
}

/**
 * Provider-neutral projection of a successful login. Providers may persist
 * richer credential metadata privately, but the host only needs these fields
 * for the success footer.
 */
export interface OAuthLoginInstallResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  account?: {
    uuid: string
    emailAddress: string
  }
  organization?: {
    uuid: string
  }
}

/** JSON-serializable value allowed in a persisted provider credential bag. */
export type AuthSecretValue =
  | string
  | number
  | boolean
  | null
  | AuthSecretValue[]
  | { [k: string]: AuthSecretValue }

/** Opaque credential bag owned by a provider strategy and persisted by host core. */
export type AuthSecretBag = { [k: string]: AuthSecretValue }

/** Provider-built credential write. Host core persists it; plugins do not touch host storage. */
export interface AuthCredentialWrite {
  serviceId: string
  displayName: string
  secrets: AuthSecretBag
}

/** Safe credential diagnostics providers may expose for host status UIs. */
export interface AuthCredentialInfo {
  /** Whether the stored credential can be decoded into runtime auth. */
  usable: boolean
  /** OAuth/API-key label for diagnostics. Defaults to the strategy display name. */
  label?: string
  /** Absolute expiry timestamp in ms since epoch, when known. */
  expiresAt?: number
  /** Whether a refresh token is present, when applicable. */
  hasRefreshToken?: boolean
  /** Provider-owned account/workspace identifiers safe to display. */
  accountId?: string
  organizationId?: string
  /** Display-safe scopes or capability names, when known. */
  scopes?: readonly string[]
  /**
   * Provider-owned detail rows for status UIs, rendered verbatim and in order.
   * Providers decide what is display-safe; hosts never interpret these values.
   */
  details?: readonly AuthCredentialDetail[]
}

/** One provider-owned diagnostic row rendered by host status UIs. */
export interface AuthCredentialDetail {
  /** Stable row key (e.g. `"email"`, `"plan"`). Hosts may use it for sorting/tests. */
  key: string
  /** Human label shown before the value. */
  label: string
  /** Display-safe value. Never put secrets here. */
  value: string
}

/**
 * Return the stable ids (email, account id, user id) that a user may type to
 * select a stored credential, for example `--credential-name me@example.com`.
 * The host matches them case-insensitively, at runtime, and never stores them.
 * Never return a secret. When absent, the host uses the shared identity fields.
 */
export type CredentialIdsHook = (secrets: AuthSecretBag) => readonly string[]

export interface OAuthLoginBuildResult {
  credential: AuthCredentialWrite
  result: OAuthLoginInstallResult
}

/**
 * Context passed to provider-owned credential refresh hooks.
 *
 * The network client is intentionally `unknown` here so the leaf contract does
 * not depend on the host's concrete transport package. Provider plugins cast it
 * to the narrow request interface they already use elsewhere.
 */
export interface OAuthCredentialRefreshContext {
  networkClient?: unknown
}

/** Provider-owned device-code prompt metadata shown by the host. */
export interface OAuthDeviceCodeChallenge {
  verificationUrl: string
  userCode: string
  expiresInMs?: number
  pollIntervalMs?: number
  providerData?: AuthSecretBag
}

/** Context passed to provider-owned device-code hooks. */
export interface OAuthDeviceCodeContext {
  networkClient?: unknown
  signal?: AbortSignal
}

/**
 * Provider-owned non-local-server code flow. The provider owns endpoint shape
 * and polling rules; the host owns display, browser opening, and persistence.
 */
export interface OAuthDeviceCodeLogin {
  request(ctx: OAuthDeviceCodeContext): Promise<OAuthDeviceCodeChallenge>
  complete(
    challenge: OAuthDeviceCodeChallenge,
    ctx: OAuthDeviceCodeContext,
  ): Promise<OAuthLoginBuildResult>
}

/**
 * Provider hook for the host's generic OAuth PKCE orchestrator.
 * The host owns browser/stdin/network mechanics; the provider owns endpoints,
 * scopes, authorize-query extras, optional device-code strategy, and
 * credential encoding.
 */
export interface OAuthLoginProvider {
  /** Stable credential-service id in the host auth store. */
  serviceId: string
  /** Human label for diagnostics/UI. */
  displayName: string
  /** Resolve current authorize/token settings. */
  config(): OAuthLoginConfig
  /** Optional provider-owned device-code flow; preferred when present. */
  deviceCode?: OAuthDeviceCodeLogin
  /** Convert the raw token response into a host-persistable credential write. */
  buildCredential(response: Record<string, unknown>): OAuthLoginBuildResult
  /** Decode a stored credential bag into runtime auth, when this OAuth credential is usable. */
  readAuth?(secrets: AuthSecretBag): ProviderAuth | null
  /** Optional safe metadata for auth-status diagnostics. */
  inspectCredential?(secrets: AuthSecretBag): AuthCredentialInfo
  /** Optional stable ids that select this credential; see {@link CredentialIdsHook}. */
  credentialIds?: CredentialIdsHook
  /** Refresh an existing OAuth credential bag and return the updated credential write. */
  refreshCredential?(
    secrets: AuthSecretBag,
    ctx: OAuthCredentialRefreshContext,
  ): Promise<OAuthLoginBuildResult>
}

/** Provider-owned API-key credential strategy. */
export interface ApiKeyAuthProvider {
  /** Stable credential-service id in the host auth store. */
  serviceId: string
  /** Human label for diagnostics/UI. */
  displayName: string
  /** Convert an API key into a host-persistable credential write. */
  buildCredential(apiKey: string): AuthCredentialWrite
  /** Decode this provider's API key from its stored opaque secret bag. */
  readApiKey(secrets: AuthSecretBag): string | null
  /** Optional safe metadata for auth-status diagnostics. */
  inspectCredential?(secrets: AuthSecretBag): AuthCredentialInfo
  /** Optional stable ids that select this credential; see {@link CredentialIdsHook}. */
  credentialIds?: CredentialIdsHook
}

/**
 * A provider, packaged for registration. `register()` wires the adapter
 * and models into the canonical registries (it wraps the provider's
 * `bootstrap<Id>()`); it MUST be idempotent.
 */
export interface ProviderPlugin {
  /** Stable provider id, matching `ModelEntry.providerId` (`"anthropic"`, `"openai"`). */
  id: string
  /** Human-friendly name for diagnostics + `--list-models`. */
  displayName: string
  /** Compact tag for dense UI (e.g. footer): `"anth"`, `"oai"`. */
  shortCode: string
  /**
   * Register this provider's adapter + model catalog. Idempotent.
   *
   * Receives an optional {@link ProviderSetupContext}: when the host passes
   * one, the plugin registers its models through `ctx.models` (the
   * `models:register` capability) instead of importing the registry from
   * `src/`. The argument is optional so the no-arg call path stays valid for
   * back-compat (a host or plugin that hasn't adopted the seam yet).
   */
  register(ctx?: ProviderSetupContext): void
  /**
   * Temporary compatibility hook for providers still using the host's legacy
   * startup auth prompt and `AuthResult` bridge. New providers should omit this
   * and resolve credentials through provider-declared auth strategies.
   */
  usesLegacyStartupAuth?: boolean
  /**
   * Optional fire-and-forget startup probe, run once after activation and
   * before the first request. Lets a provider overlay server-shipped data
   * onto the registry (e.g. a `/bootstrap` model-cost override).
   * MUST NOT throw and MUST self-gate (e.g. no-op for the wrong auth kind);
   * failures are tolerated as a best-effort UX improvement. Keeping this on
   * the plugin is what lets the host entry point start providers without naming
   * any of them.
   */
  onStartupProbe?(ctx: ProviderStartupContext): void

  /**
   * Optional host hook for one-off model ids the static catalog does not know
   * yet. Providers like OpenRouter can proxy arbitrary upstream slugs; when
   * the host needs to accept one, it can ask the provider to register a
   * synthetic local entry.
   */
  registerAdHocModel?(modelId: string): void

  /**
   * Optional: fetch this provider's LIVE model catalog (the authoritative
   * server-side list, including ids the static registry may not know yet).
   * Used by the REPL model picker and the `models-live` command — **not**
   * by `ma models` / `--list-models`, which stay registry-only / offline.
   * Implementations own their endpoint, auth headers, and any client-side
   * variant synthesis (e.g. context-window aliases). Must REJECT or resolve
   * `[]` on failure — callers treat errors as "live list unavailable".
   */
  listLiveModels?(auth: ProviderAuth): Promise<LiveModelRow[]>

  /**
   * Optional: declare that {@link listLiveModels} works WITHOUT stored
   * credentials (the provider's model-list endpoint is public). When `true`,
   * the picker / `models-live` still invoke `listLiveModels` for this
   * provider when no credential is stored, passing an anonymous
   * `{ kind: "custom", headers: {} }` auth. Providers whose catalog needs auth
   * (the default) omit this, so an unauthenticated live listing skips them.
   * Gateways like HuggingFace, whose `/v1/models` is public, set it so the
   * full live catalog shows before login.
   */
  publicModelList?: boolean

  /**
   * Optional: describe the protocol beta/feature flags this provider can send,
   * for the `--list-flags` command. Pure; no I/O. Each {@link BetaFlagInfo}
   * documents one flag's wire value, effect, and attach condition. Core renders
   * the union across every registered provider, so adding a provider extends
   * the listing with zero edits to the command (OCP).
   */
  listBetaFlags?(): BetaFlagInfo[]

  /**
   * Optional: parse a compact VERSION token from one of this provider's
   * model ids for dense UI labels (`<shortCode>-<token>`, e.g. a footer
   * label built from the id). Return `undefined` when the id doesn't
   * match the provider's naming scheme — core then falls back to a
   * generic date-suffix strip. Pure; no I/O.
   */
  modelVersionToken?(modelId: string): string | undefined

  /**
   * Optional: the FULL compact label for one of this provider's model ids
   * (e.g. `"opus-5.5"`). When it returns a string, core uses it as is and
   * skips the `<shortCode>-<token>` join. Use it when the model family says
   * more than the provider tag. Return `undefined` to keep the default join.
   * Pure; no I/O.
   */
  modelShortLabel?(modelId: string): string | undefined

  /**
   * Optional: resolve the FINAL system-prompt blocks for this provider from
   * the agent's neutral skeleton. See {@link SystemPromptContext}. When
   * absent, the agent uses {@link neutralSystemPrompt}. Pure + synchronous:
   * the agent caches the result and folds it into the resume-drift hash, so
   * this MUST be deterministic for a given context.
   */
  resolveSystemPrompt?(ctx: SystemPromptContext): SystemPromptBlock[]

  /**
   * Optional: read provider-neutral session metadata (quota windows,
   * context window, model label) for the status bar.
   *
   * **MUST be cache-only / non-blocking.** The status-bar slot calls this
   * on every refresh tick and on every `quota.headersReceived` bus event;
   * a network round-trip here blocks the live-area scheduler's per-slot
   * `timeoutMs` and starves other refreshes. Population of the cache is
   * the provider's separate concern: either piggyback on real chat
   * responses (capture `x-ratelimit-*` headers in the adapter) OR implement
   * {@link primeSessionInfo} for a cold-start probe.
   *
   * MUST honor `ctx.signal` (trivially — no I/O to cancel) and resolve to
   * `null` (not throw) on failure so the footer degrades gracefully. A
   * provider with no quota concept can still return
   * `{ contextWindow, modelLabel }` (no `quota`). When absent, core
   * synthesizes a context-only view from the model registry.
   */
  fetchSessionInfo?(ctx: ProviderSessionContext): Promise<ProviderSessionInfo | null>

  /**
   * Optional: warm whatever cache {@link fetchSessionInfo} reads from.
   * Called fire-and-forget by the agent boot for the selected provider,
   * AFTER {@link onStartupProbe} and BEFORE the REPL paints.
   *
   * The intended shape is "kick off a bounded probe in the background,
   * populate the cache on success" — e.g. a 1-token cheap-tier POST whose
   * response headers carry the provider's rate-limit window. When the probe
   * lands, it broadcasts via `quota.headersReceived`, which refires the
   * status-bar slot with a fresh cache.
   *
   * Providers whose cache fills from real chat traffic (capture headers in
   * the adapter) typically omit this hook.
   *
   * MUST NOT throw and SHOULD self-deduplicate (a second prime call
   * while the first is in flight should join the same promise, not
   * spawn a second probe). Failures are tolerated — the slot just keeps
   * showing the manifest placeholder until real traffic fills the cache.
   */
  primeSessionInfo?(ctx: ProviderSessionContext): Promise<void>

  /**
   * Optional: read the plan, seat, role, and usage windows for one
   * credential from the provider's account endpoints. Used by the host's
   * `auth-status plan` command, never on the request path.
   *
   * MUST NOT spend model quota (no inference calls). MUST resolve `null`
   * when `auth` is a kind the provider cannot inspect (for example an API
   * key with no account endpoint). MAY reject on network or HTTP failure;
   * the host shows the reason on that credential's row. MUST honor
   * `ctx.signal`.
   */
  fetchAccountPlan?(auth: ProviderAuth, ctx?: AccountPlanContext): Promise<AccountPlanInfo | null>

  /**
   * Optional login strategy. Providers with first-party OAuth plan auth expose
   * this so `minimal-agent --login` can run without core knowing provider
   * endpoints, scope sets, or credential codecs.
   */
  oauthLogin?: OAuthLoginProvider

  /**
   * Optional API-key auth strategy. Used both by interactive login
   * (`--login --provider <id> --api-key`) and by canonical transport
   * credential resolution.
   */
  apiKeyAuth?: ApiKeyAuthProvider

  /**
   * Optional: auth used when no credential is stored for this provider.
   * When present, startup and transport resolution return it instead of
   * throwing `no credentials for provider`. An explicit credential name that
   * does not exist still throws. Absent keeps today's behavior (throw).
   */
  anonymousAuth?(): ProviderAuth

  /**
   * Optional: old provider ids that resolve to this provider. A lookup by a
   * former id (config `provider`, `--provider`, `provider <id> login`, session
   * resume) returns this plugin and emits a one-time deprecation warning.
   */
  formerIds?: readonly string[]
}
