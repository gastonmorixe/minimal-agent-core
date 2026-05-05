/**
 * Brave Search provider for the WebSearch plugin.
 *
 * Implements `WebSearchProvider` against Brave's REST API:
 *
 *   GET https://api.search.brave.com/res/v1/web/search
 *   GET https://api.search.brave.com/res/v1/news/search
 *   Headers: X-Subscription-Token, Accept: application/json
 *
 * Zero deps — uses the runtime's `fetch`. The constructor accepts an
 * injectable `fetch` so unit tests stub it without touching the network.
 *
 * Brave's response shape is sprawling (~1400 lines of pydantic in the
 * official python client). We only consume the handful of fields the
 * formatter actually renders: title, url, description, age/page_age,
 * meta_url.hostname, thumbnail.src.
 *
 * Auth: API key from `apiKey` (config inline) → `apiKeyEnv` (config) →
 * `BRAVE_API_KEY` (env, default name).
 *
 * @module web-search/providers/brave
 */

import type {
  ProviderConfig,
  ProviderFactory,
  SearchHit,
  SearchOptions,
  SearchResponse,
  SearchType,
  WebSearchProvider,
} from "./types.ts"
import { WebSearchProviderError } from "./types.ts"

const DEFAULT_API_KEY_ENV = "BRAVE_API_KEY"
const BASE_URL = "https://api.search.brave.com/res/v1/"
/** Brave's hard limit on query string length. Mirrored client-side. */
export const MAX_QUERY_LENGTH = 400
/** Brave's hard limit on whitespace-separated terms. */
export const MAX_QUERY_TERMS = 50

/** Per-vertical hard caps from Brave's docs. */
const COUNT_CAPS: Record<SearchType, number> = { web: 20, news: 50 }

/** Minimal slice of Brave's web-search response we actually read. */
interface BraveWebPayload {
  web?: {
    results?: BraveWebResult[]
  }
  query?: { original?: string; altered?: string }
  mixed?: unknown
}
interface BraveWebResult {
  title?: string
  url?: string
  description?: string
  age?: string
  page_age?: string
  meta_url?: { hostname?: string }
  thumbnail?: { src?: string }
}

/** Minimal slice of Brave's news-search response we actually read. */
interface BraveNewsPayload {
  results?: BraveNewsResult[]
  query?: { original?: string; altered?: string }
}
interface BraveNewsResult {
  title?: string
  url?: string
  description?: string
  age?: string
  page_age?: string
  meta_url?: { hostname?: string }
  thumbnail?: { src?: string }
}

/** Strip HTML highlight markers Brave may include in titles/snippets. */
function stripDecorations(s: string | undefined): string | undefined {
  if (!s) return s
  return s.replace(/<\/?strong>/g, "")
}

function hostnameFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** Map a Brave web result → normalized SearchHit. */
function normalizeWeb(r: BraveWebResult): SearchHit | null {
  if (!r.title || !r.url) return null
  return {
    title: stripDecorations(r.title)!,
    url: r.url,
    snippet: stripDecorations(r.description),
    age: r.age ?? r.page_age,
    source: r.meta_url?.hostname ?? hostnameFromUrl(r.url),
    thumbnail: r.thumbnail?.src,
    type: "web",
  }
}

function normalizeNews(r: BraveNewsResult): SearchHit | null {
  if (!r.title || !r.url) return null
  return {
    title: stripDecorations(r.title)!,
    url: r.url,
    snippet: stripDecorations(r.description),
    age: r.age ?? r.page_age,
    source: r.meta_url?.hostname ?? hostnameFromUrl(r.url),
    thumbnail: r.thumbnail?.src,
    type: "news",
  }
}

/** Build the query-string params Brave expects for a given vertical. */
export function buildQueryParams(query: string, opts: SearchOptions): URLSearchParams {
  const p = new URLSearchParams()
  p.set("q", query)
  const cap = COUNT_CAPS[opts.type]
  const count = Math.max(1, Math.min(cap, opts.count))
  p.set("count", String(count))
  if (typeof opts.offset === "number" && opts.offset > 0) {
    // Brave caps offset at 9 (page index, not row offset). Clamp.
    p.set("offset", String(Math.min(9, opts.offset)))
  }
  if (opts.country) p.set("country", opts.country)
  if (opts.lang) p.set("search_lang", opts.lang)
  if (opts.safesearch) p.set("safesearch", opts.safesearch)
  if (opts.freshness) p.set("freshness", opts.freshness)
  // Always disable highlight markers — we'd just have to strip them.
  p.set("text_decorations", "false")
  // Spellcheck on by default; Brave will surface the altered query.
  p.set("spellcheck", "true")
  return p
}

/** Provider config narrowed for Brave. */
interface BraveConfig {
  apiKey?: string
  apiKeyEnv?: string
  /** Optional override for the base URL (tests, proxies). */
  baseUrl?: string
  /** Optional override for `fetch` (tests). */
  fetch?: typeof fetch
}

function readBraveConfig(raw: ProviderConfig): BraveConfig {
  const out: BraveConfig = {}
  if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) out.apiKey = raw.apiKey
  if (typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.length > 0)
    out.apiKeyEnv = raw.apiKeyEnv
  if (typeof raw.baseUrl === "string" && raw.baseUrl.length > 0) out.baseUrl = raw.baseUrl
  if (typeof raw.fetch === "function") out.fetch = raw.fetch as typeof fetch
  return out
}

class BraveProvider implements WebSearchProvider {
  readonly id = "brave"
  readonly displayName = "Brave Search"
  readonly capabilities: ReadonlySet<SearchType> = new Set(["web", "news"])

  private readonly cfg: BraveConfig
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(config: ProviderConfig) {
    this.cfg = readBraveConfig(config)
    this.baseUrl = this.cfg.baseUrl ?? BASE_URL
    this.fetchImpl = this.cfg.fetch ?? fetch
  }

  /** Resolve the API key from config or env. */
  private apiKey(env: Record<string, string | undefined>): string | undefined {
    if (this.cfg.apiKey) return this.cfg.apiKey
    const envName = this.cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV
    return env[envName]
  }

  isConfigured(env: Record<string, string | undefined>): boolean {
    return !!this.apiKey(env)
  }

  async search(
    query: string,
    opts: SearchOptions,
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    if (!this.capabilities.has(opts.type)) {
      throw new WebSearchProviderError(
        this.id,
        `unsupported search type "${opts.type}" (supported: ${[...this.capabilities].join(", ")})`,
      )
    }
    const key = this.apiKey(process.env)
    if (!key) {
      throw new WebSearchProviderError(this.id, "no API key configured")
    }
    if (query.length === 0) {
      throw new WebSearchProviderError(this.id, "query is empty")
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new WebSearchProviderError(
        this.id,
        `query exceeds ${MAX_QUERY_LENGTH} characters`,
      )
    }
    if (query.split(/\s+/).filter(Boolean).length > MAX_QUERY_TERMS) {
      throw new WebSearchProviderError(
        this.id,
        `query exceeds ${MAX_QUERY_TERMS} terms`,
      )
    }

    const params = buildQueryParams(query, opts)
    const url = `${this.baseUrl}${opts.type}/search?${params.toString()}`
    const headers: Record<string, string> = {
      "X-Subscription-Token": key,
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "User-Agent": "minimal-agent-websearch/0.1",
    }

    let resp: Response
    try {
      resp = await this.fetchImpl(url, { headers, signal })
    } catch (err) {
      throw new WebSearchProviderError(this.id, `fetch failed: ${(err as Error).message}`, err)
    }

    if (!resp.ok) {
      let body = ""
      try {
        body = (await resp.text()).slice(0, 500)
      } catch {
        // ignore
      }
      throw new WebSearchProviderError(
        this.id,
        `HTTP ${resp.status} ${resp.statusText}${body ? `: ${body}` : ""}`,
      )
    }

    let payload: unknown
    try {
      payload = await resp.json()
    } catch (err) {
      throw new WebSearchProviderError(this.id, `invalid JSON: ${(err as Error).message}`, err)
    }

    if (!payload || typeof payload !== "object") {
      throw new WebSearchProviderError(this.id, "response was not an object")
    }

    const echoedQuery =
      (payload as { query?: { altered?: string; original?: string } }).query?.altered ??
      (payload as { query?: { original?: string } }).query?.original ??
      query

    let hits: SearchHit[]
    if (opts.type === "web") {
      const p = payload as BraveWebPayload
      const results = p.web?.results ?? []
      hits = results.map(normalizeWeb).filter((h): h is SearchHit => h !== null)
    } else {
      const p = payload as BraveNewsPayload
      const results = p.results ?? []
      hits = results.map(normalizeNews).filter((h): h is SearchHit => h !== null)
    }

    return {
      query: echoedQuery,
      provider: this.id,
      type: opts.type,
      hits,
    }
  }
}

export const braveFactory: ProviderFactory = (config) => new BraveProvider(config)
