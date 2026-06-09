/**
 * Provider-plugin contract + registry.
 *
 * A `ProviderPlugin` is a self-describing unit that contributes ONE
 * provider (its `ProviderAdapter` + model catalog) to the canonical
 * registries when activated. It is the seam the composition root uses to
 * wire providers, so the agent entrypoint never names a provider by hand.
 *
 * This is the SAME shape each `plugins/llm-<id>/` package exports. The
 * provider loader (`provider-discovery.ts`) scans `plugins/llm-*` for a
 * `provider.json`, dynamically imports the declared `ProviderPlugin`, and
 * registers it here, so the core never imports a provider by name.
 *
 * @module llm/provider-plugin
 */

import type { ProviderAuth } from "./provider.ts"

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

// ---------------------------------------------------------------------------
// System-prompt resolution (Strategy + Template Method)
// ---------------------------------------------------------------------------

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
 *   - Anthropic + OAuth (plan auth) prepends its mandatory billing header and
 *     the exact `"You are Claude Code, …"` identity (their server validates the
 *     prefix), dropping the neutral identity.
 *   - Anthropic + api-key / OpenAI / OpenRouter keep the neutral identity and
 *     add nothing (or whatever they need).
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
 * One usage/quota window, provider-neutral. Anthropic surfaces `"5h"` / `"7d"`
 * plan windows; another provider might surface `"rpm"` / `"tpm"` or nothing.
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
   * overage allowance is engaged/permitted (e.g. Anthropic's `"allowed"`);
   * `active: false` ⇒ overage is off. Absent ⇒ the provider has no overage
   * concept (or didn't report it this tick). Overage has no utilization, so it
   * is NOT a {@link QuotaWindow}; the footer surfaces only the "off" readout,
   * and only when the user opts in.
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
  /** Register this provider's adapter + model catalog. Idempotent. */
  register(): void
  /**
   * Optional fire-and-forget startup probe, run once after activation and
   * before the first request. Lets a provider overlay server-shipped data
   * onto the registry (e.g. Anthropic's `/bootstrap` model-cost overrides).
   * MUST NOT throw and MUST self-gate (e.g. no-op for the wrong auth kind);
   * failures are tolerated as a best-effort UX improvement. Keeping this on
   * the plugin is what lets `src/index.ts` start providers without naming
   * any of them.
   */
  onStartupProbe?(ctx: ProviderStartupContext): void

  /**
   * Optional: fetch this provider's LIVE model catalog (the authoritative
   * server-side list, including ids the static registry may not know yet).
   * Used by `--list-models` / the model picker to merge real-time rows
   * over the registry. Implementations own their endpoint, auth headers,
   * and any client-side variant synthesis (e.g. context-window aliases).
   * Must REJECT or resolve `[]` on failure — callers treat errors as
   * "live list unavailable" and fall back to the registry (OCP: adding a
   * provider never edits the listing command).
   */
  listLiveModels?(auth: ProviderAuth): Promise<LiveModelRow[]>

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
   * responses (OpenAI / OpenRouter: capture `x-ratelimit-*` headers in
   * the adapter) OR implement {@link primeSessionInfo} for a cold-start
   * probe.
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
   * populate the cache on success" — for Anthropic, that's a 1-token
   * Haiku POST whose response headers carry `anthropic-ratelimit-*`
   * (see `plugins/llm-anthropic/session-info.ts`). When the probe lands,
   * it broadcasts via `quota.headersReceived`, which refires the
   * status-bar slot with a fresh cache.
   *
   * Providers whose cache fills from real chat traffic (OpenAI,
   * OpenRouter capture headers in the adapter) typically omit this hook.
   *
   * MUST NOT throw and SHOULD self-deduplicate (a second prime call
   * while the first is in flight should join the same promise, not
   * spawn a second probe). Failures are tolerated — the slot just keeps
   * showing the manifest placeholder until real traffic fills the cache.
   */
  primeSessionInfo?(ctx: ProviderSessionContext): Promise<void>
}

const plugins = new Map<string, ProviderPlugin>()

/** Add (or replace) a provider plugin. Does NOT activate it. */
export function registerProviderPlugin(plugin: ProviderPlugin): void {
  plugins.set(plugin.id, plugin)
}

/** Enumerate registered provider plugins. */
export function listProviderPlugins(): ProviderPlugin[] {
  return [...plugins.values()]
}

/** Look up a provider plugin by id (e.g. to map a model's providerId → shortCode). */
export function findProviderPlugin(id: string): ProviderPlugin | undefined {
  return plugins.get(id)
}

/**
 * Activate every registered provider plugin (calls each `register()`).
 * Idempotent because `register()` is. Returns the activated ids.
 */
export function activateProviderPlugins(): string[] {
  const activated: string[] = []
  for (const plugin of plugins.values()) {
    plugin.register()
    activated.push(plugin.id)
  }
  return activated
}

/** Drop all registered provider plugins. Tests only. */
export function clearProviderPlugins(): void {
  plugins.clear()
}
