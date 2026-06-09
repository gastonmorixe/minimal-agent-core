/**
 * Provider abstraction for the WebSearch plugin.
 *
 * A `WebSearchProvider` knows how to turn a `(query, options)` pair into a
 * normalized `SearchResponse`. Providers are stateless: the registry
 * instantiates one per resolved id, holds it for the process lifetime, and
 * dispatches calls. All HTTP is internal to the provider; the abstraction
 * stays free of any one provider's quirks.
 *
 * @module web-search/providers/types
 */

/** Search verticals. Day-one we ship `web` and `news`. */
export type SearchType = "web" | "news"

/**
 * One normalized search hit. Provider-specific fields (e.g. Brave's
 * `meta_url`, Tavily's `score`) are flattened into this shape so the
 * formatter and the model don't care which provider fulfilled the request.
 */
export interface SearchHit {
  /** Page title. Always present. */
  title: string
  /** Canonical URL. Always present. */
  url: string
  /** Short excerpt / description. May be absent for sparse providers. */
  snippet?: string
  /** Human-readable age ("2 days ago") or ISO date. Provider-best-effort. */
  age?: string
  /** Domain or publisher name (`example.com`, "Reuters"). */
  source?: string
  /** Optional thumbnail URL. */
  thumbnail?: string
  /** Which vertical this hit came from. */
  type: SearchType
}

/** Normalized request options, post-merge with config defaults. */
export interface SearchOptions {
  type: SearchType
  /** Page size. 1..20 for web, 1..50 for news (provider-clamped). */
  count: number
  /** Page index (0-based). Brave caps at 9; we pass through. */
  offset?: number
  /** `pd` | `pw` | `pm` | `py` | `YYYY-MM-DDtoYYYY-MM-DD`. */
  freshness?: string
  /** ISO-2 country code or `ALL`. */
  country?: string
  /** 2-char language code. */
  lang?: string
  /** Adult content filter. */
  safesearch?: "off" | "moderate" | "strict"
}

/** Normalized response. */
export interface SearchResponse {
  /** Echoed query (possibly post-spellcheck if the provider rewrote it). */
  query: string
  /** Provider id that produced this response. */
  provider: string
  /** Vertical. */
  type: SearchType
  /** Ordered hits. May be empty — empty is a *valid* result, not an error. */
  hits: SearchHit[]
  /** Optional total-available count (for pagination UX). */
  totalAvailable?: number
}

/**
 * Provider-shaped error. Thrown by `search()` for any non-success outcome
 * the registry should treat as a fall-through trigger (5xx, network,
 * malformed response). 4xx auth errors should still throw — the chain
 * advances to the next provider, since "Brave's key is wrong" doesn't
 * mean Tavily can't help.
 */
export class WebSearchProviderError extends Error {
  constructor(
    public providerId: string,
    message: string,
    public cause?: unknown,
  ) {
    super(`[${providerId}] ${message}`)
    this.name = "WebSearchProviderError"
  }
}

/** Per-provider config block. Free-form; providers narrow as needed. */
export type ProviderConfig = Record<string, unknown>

/** Minimal interface every provider implements. */
export interface WebSearchProvider {
  /** Stable id used in config and tool input (`"brave"`). */
  readonly id: string
  /** Human-readable name for logs and the CLI. */
  readonly displayName: string
  /** Which verticals this provider supports. */
  readonly capabilities: ReadonlySet<SearchType>
  /**
   * Whether the provider has the credentials it needs. Called by the
   * registry to skip a provider before dispatching. Read env *and* the
   * provider config block (which can carry an inline `apiKey` or override
   * the env var name via `apiKeyEnv`).
   */
  isConfigured(env: Record<string, string | undefined>): boolean
  /**
   * Execute the search. Must honor `signal` (forward to fetch). Throws
   * `WebSearchProviderError` on failure; returns a normalized
   * `SearchResponse` on success (even when hits are empty).
   */
  search(query: string, opts: SearchOptions, signal: AbortSignal): Promise<SearchResponse>
}

/** A provider factory: takes its config block and returns an instance. */
export type ProviderFactory = (config: ProviderConfig) => WebSearchProvider
