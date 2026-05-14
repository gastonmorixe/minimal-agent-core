/**
 * Memory plugin user-config reader.
 *
 * Reads `~/.minimal-agent/config.jsonc` (overridable via
 * `MINIMAL_AGENT_CONFIG`) and extracts the memory-plugin-specific slice
 * at `plugins.memory.summary.*`. Returns a fully-defaulted config so
 * callers don't have to deal with `undefined`s.
 *
 * Lives in the memory plugin (not `src/config.ts`) to keep the agent
 * core unaware of plugin-specific keys. Other plugins follow the same
 * pattern (`tui-plugins/quota-status/`, `tui-plugins/web-search/`).
 *
 * Lenient parsing: unknown keys ignored, invalid types fall back to
 * defaults. Never throws.
 *
 * @module memory/lib/memory-config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { MODELS } from "../../../src/headers.ts"
import { parseJsonc } from "../../../src/jsonc.ts"

/**
 * Fully-resolved memory-summary config. All fields are required (the
 * loader fills in defaults so callers don't have to).
 */
export interface MemorySummaryConfig {
  /** Master switch. Default: false (opt-in until vetted). */
  enabled: boolean
  /**
   * Model id used for the summary LLM call. Defaults to Haiku
   * (`claude-haiku-4-5-20251001`) — cheap, fast, fine for compression.
   * Pass-through to the wire: server validates.
   */
  model: string
  /**
   * Below this bullet count, skip the summarizer and inject verbatim.
   * Small memory files don't need compression. Default: 30.
   */
  minBullets: number
  /**
   * OR: below this byte count, skip the summarizer. Default: 15_000.
   * Either threshold alone triggers the skip.
   */
  minBytes: number
  /**
   * Minimum number of bullets newer than the last regen cutoff before
   * we trigger a fresh regen. Below this, we keep the existing summary
   * and just inject the new bullets as headlines under "Recent saves".
   * Default: 3.
   */
  dirtyBullets: number
}

/** Defaults, applied when keys are missing or malformed. */
export const DEFAULT_MEMORY_SUMMARY_CONFIG: MemorySummaryConfig = {
  enabled: false,
  model: MODELS.HAIKU,
  minBullets: 30,
  minBytes: 15_000,
  dirtyBullets: 3,
}

/**
 * Resolve the user-config path. Mirrors `src/config.ts:configPath`
 * exactly so both readers see the same file.
 */
export function memoryConfigPath(opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env
  const override = env.MINIMAL_AGENT_CONFIG
  if (override) return override
  const home = opts.home ?? homedir()
  const dir = join(home, ".minimal-agent")
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}

/**
 * Read and validate the memory-summary slice of the user config.
 *
 * Returns {@link DEFAULT_MEMORY_SUMMARY_CONFIG} for any failure mode
 * (missing file, parse error, wrong types). Never throws.
 *
 * The optional `opts.path` argument is for tests; in production callers
 * pass nothing and `memoryConfigPath()` is consulted.
 */
export function loadMemorySummaryConfig(
  opts: { path?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): MemorySummaryConfig {
  const path = opts.path ?? memoryConfigPath({ home: opts.home, env: opts.env })
  if (!existsSync(path)) return { ...DEFAULT_MEMORY_SUMMARY_CONFIG }

  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return { ...DEFAULT_MEMORY_SUMMARY_CONFIG }
  }

  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch {
    return { ...DEFAULT_MEMORY_SUMMARY_CONFIG }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_MEMORY_SUMMARY_CONFIG }
  }

  const root = parsed as Record<string, unknown>
  const plugins = root.plugins
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return { ...DEFAULT_MEMORY_SUMMARY_CONFIG }
  }
  const memSlice = (plugins as Record<string, unknown>).memory
  if (!memSlice || typeof memSlice !== "object" || Array.isArray(memSlice)) {
    return { ...DEFAULT_MEMORY_SUMMARY_CONFIG }
  }
  const summarySlice = (memSlice as Record<string, unknown>).summary
  if (!summarySlice || typeof summarySlice !== "object" || Array.isArray(summarySlice)) {
    return { ...DEFAULT_MEMORY_SUMMARY_CONFIG }
  }

  const s = summarySlice as Record<string, unknown>
  const out: MemorySummaryConfig = { ...DEFAULT_MEMORY_SUMMARY_CONFIG }

  if (typeof s.enabled === "boolean") out.enabled = s.enabled
  if (typeof s.model === "string" && s.model.length > 0) out.model = s.model
  if (typeof s.minBullets === "number" && Number.isFinite(s.minBullets) && s.minBullets >= 0) {
    out.minBullets = Math.floor(s.minBullets)
  }
  if (typeof s.minBytes === "number" && Number.isFinite(s.minBytes) && s.minBytes >= 0) {
    out.minBytes = Math.floor(s.minBytes)
  }
  if (
    typeof s.dirtyBullets === "number" &&
    Number.isFinite(s.dirtyBullets) &&
    s.dirtyBullets >= 0
  ) {
    out.dirtyBullets = Math.floor(s.dirtyBullets)
  }

  return out
}
