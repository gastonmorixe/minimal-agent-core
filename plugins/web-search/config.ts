/**
 * Read the WebSearch plugin config from the user's global minimal-agent
 * config file.
 *
 * Source: `~/.minimal-agent/config.jsonc` (or `MINIMAL_AGENT_CONFIG`),
 * key path: `plugins["web-search"]`.
 *
 * Lenient: missing file, missing section, malformed JSON, wrong types →
 * empty defaults. Never throws — bad config must not break the agent at
 * startup, and a misconfigured plugin should still surface a clear runtime
 * error from the handler ("no provider configured") rather than crash.
 *
 * Shape:
 *
 * ```
 *   {
 *     "plugins": {
 *       "web-search": {
 *         "enabled": true,                       // default true
 *         "providers": ["brave"],                // chain in preference order
 *         "defaults": {                          // applied to every search
 *           "count": 10,
 *           "safesearch": "moderate",
 *           "country": "ALL",
 *           "lang": "en"
 *         },
 *         "brave": {                             // provider-specific block
 *           "apiKeyEnv": "BRAVE_API_KEY",        // env var to read
 *           "apiKey": null                       // or inline (less secure)
 *         }
 *       }
 *     }
 *   }
 * ```
 *
 * @module web-search/config
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"
import { parseJsonc } from "@minimal-agent/plugin-api/utils/jsonc"

import type { ProviderConfig, SearchType } from "./providers/types.ts"

export interface WebSearchDefaults {
  count?: number
  offset?: number
  freshness?: string
  country?: string
  lang?: string
  safesearch?: "off" | "moderate" | "strict"
  type?: SearchType
}

export interface WebSearchConfig {
  /** When `false`, the loader skips the plugin entirely. */
  enabled: boolean
  /** Provider chain in preference order. */
  providers: string[]
  /** Defaults applied to every tool call (overridden by per-call args). */
  defaults: WebSearchDefaults
  /** Per-provider config blocks, keyed by provider id. */
  providerConfigs: Record<string, ProviderConfig>
}

const VALID_SAFESEARCH = new Set(["off", "moderate", "strict"])
const VALID_TYPE = new Set<SearchType>(["web", "news"])

/** Defaults when nothing is configured. */
export function defaultConfig(): WebSearchConfig {
  return {
    enabled: true,
    providers: ["brave"],
    defaults: { count: 10, safesearch: "moderate", country: "ALL", lang: "en" },
    providerConfigs: { brave: { apiKeyEnv: "BRAVE_API_KEY" } },
  }
}

/** Resolve config path, mirroring `src/config.ts:configPath`. */
export function configPath(): string {
  if (process.env.MINIMAL_AGENT_CONFIG) return process.env.MINIMAL_AGENT_CONFIG
  const dir = resolveAgentHome()
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}

/** Read the file, return raw text or `null` on any failure. */
function readRaw(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/**
 * Validate and normalize a `plugins["web-search"]` block. Unknown / wrong-type
 * fields are dropped; valid fields override defaults. Returns the merged
 * `WebSearchConfig`.
 */
export function parseWebSearchConfig(raw: unknown): WebSearchConfig {
  const out = defaultConfig()
  if (!isPlainObject(raw)) return out
  const plugins = raw.plugins
  if (!isPlainObject(plugins)) return out
  const ws = plugins["web-search"]
  if (!isPlainObject(ws)) return out

  if (typeof ws.enabled === "boolean") out.enabled = ws.enabled

  if (Array.isArray(ws.providers)) {
    const ids = ws.providers.filter((x): x is string => typeof x === "string" && x.length > 0)
    if (ids.length > 0) out.providers = ids
  }

  if (isPlainObject(ws.defaults)) {
    const d = ws.defaults
    const dd: WebSearchDefaults = {}
    if (typeof d.count === "number" && d.count > 0) dd.count = Math.floor(d.count)
    if (typeof d.offset === "number" && d.offset >= 0) dd.offset = Math.floor(d.offset)
    if (typeof d.freshness === "string" && d.freshness.length > 0) dd.freshness = d.freshness
    if (typeof d.country === "string" && d.country.length > 0) dd.country = d.country
    if (typeof d.lang === "string" && d.lang.length > 0) dd.lang = d.lang
    if (typeof d.safesearch === "string" && VALID_SAFESEARCH.has(d.safesearch)) {
      dd.safesearch = d.safesearch as WebSearchDefaults["safesearch"]
    }
    if (typeof d.type === "string" && VALID_TYPE.has(d.type as SearchType)) {
      dd.type = d.type as SearchType
    }
    out.defaults = { ...out.defaults, ...dd }
  }

  // Per-provider blocks: any object-valued key under ws (other than the
  // known top-level keys) is treated as a provider config block.
  const known = new Set(["enabled", "providers", "defaults"])
  const providerConfigs: Record<string, ProviderConfig> = { ...out.providerConfigs }
  for (const [k, v] of Object.entries(ws)) {
    if (known.has(k)) continue
    if (isPlainObject(v)) providerConfigs[k] = v
  }
  out.providerConfigs = providerConfigs

  return out
}

/**
 * Load and parse the user config. Always returns a valid `WebSearchConfig`
 * (built-in defaults on any failure). Use `defaultConfig()` directly if you
 * want to skip disk IO entirely (tests, CLI).
 */
export function loadWebSearchConfig(): WebSearchConfig {
  const path = configPath()
  const raw = readRaw(path)
  if (raw === null) return defaultConfig()
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch (err) {
    if (process.env.DEBUG === "1") {
      process.stderr.write(`[web-search] ${path}: parse error: ${(err as Error).message}\n`)
    }
    return defaultConfig()
  }
  return parseWebSearchConfig(parsed)
}
