/**
 * Memory plugin user-config reader.
 *
 * Reads `~/.minimal-agent/config.jsonc` (overridable via
 * `MINIMAL_AGENT_CONFIG`) and extracts the `plugins.memory.*` slice into
 * a fully-defaulted {@link MemoryConfig} so callers don't have to deal
 * with `undefined`s.
 *
 * Lives in the memory plugin (not `src/config.ts`) to keep the agent
 * core unaware of plugin-specific keys. Other plugins follow the same
 * pattern (`plugins/quota-status/`, `plugins/web-search/`).
 *
 * ## Inject mode
 *
 * The single most important knob is {@link MemoryConfig.inject}, which
 * controls whether (and how) the plugin injects memory bullets into the
 * system prompt at session start:
 *
 *   - `"none"` (default): no bullet dump. The plugin's `PROMPT.md` and
 *     the `MemoryTool` schema still load, so the model knows the tool
 *     exists and is taught to query it on demand. Keeps the system
 *     prompt small.
 *   - `"verbatim"`: legacy behavior: full `memory.md` injected as a
 *     `## Saved memories` block.
 *   - `"summary"`: LLM-derived condensed view via `summary-refresh.ts`.
 *     Uses {@link MemoryConfig.summary} for thresholds.
 *
 * ## Back-compat
 *
 * Earlier versions used `plugins.memory.summary.enabled: boolean` as the
 * sole gate (default false → verbatim). Users who set that to `true`
 * are silently migrated to `inject: "summary"` when `inject` itself is
 * unset. Users who were on the default (false) are migrated to the new
 * default `inject: "none"` (the explicit intent of this change).
 *
 * Lenient parsing: unknown keys ignored, invalid types fall back to
 * defaults. Never throws.
 *
 * @module memory/lib/memory-config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { findModelByTags } from "../../../src/llm/model-registry.ts"
import { parseJsonc } from "../../../src/jsonc.ts"

/**
 * Default summarizer model: the cheap/fast Anthropic tier, resolved from
 * the model registry by tags so this plugin no longer hardcodes a model
 * id via `src/headers.ts` (refactor Wave 1: plugins must not reach into
 * the legacy wire module for catalog data). The literal fallback covers
 * early-boot callers that read the config before the provider plugin
 * registered its models; it matches the registry's current haiku id.
 */
export function defaultSummaryModel(): string {
  return findModelByTags("anthropic", ["haiku", "production"])?.id ?? "claude-haiku-4-5-20251001"
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How (or whether) memories are injected into the system prompt at
 * session start. See module docstring for semantics.
 */
export type MemoryInjectMode = "none" | "verbatim" | "summary"

/** Whitelist of accepted string values for {@link MemoryInjectMode}. */
const VALID_INJECT_MODES: ReadonlySet<MemoryInjectMode> = new Set([
  "none",
  "verbatim",
  "summary",
])

/**
 * Parameters used by the optional LLM-summary pipeline. Only consulted
 * when {@link MemoryConfig.inject} === "summary".
 */
export interface MemorySummaryParams {
  /**
   * Model id used for the summary LLM call. Defaults to Haiku
   * (`claude-haiku-4-5`): cheap, fast, fine for compression.
   * Pass-through to the wire: server validates.
   */
  model: string
  /**
   * Below this bullet count, skip the summarizer and fall back to
   * verbatim. Small memory files don't need compression. Default: 30.
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

/**
 * Resolved, fully-defaulted memory-plugin config. Returned by
 * {@link loadMemoryConfig}.
 */
export interface MemoryConfig {
  /** How (or whether) to inject memories at session start. */
  inject: MemoryInjectMode
  /** Summary-mode params. Only used when {@link inject} === "summary". */
  summary: MemorySummaryParams
}

/** Built-in defaults, applied per-key when missing or malformed. */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  inject: "none",
  summary: {
    model: defaultSummaryModel(),
    minBullets: 30,
    minBytes: 15_000,
    dirtyBullets: 3,
  },
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user-config path. Mirrors `src/config.ts:configPath`
 * exactly so both readers see the same file.
 *
 * Resolution order (highest precedence first):
 *   1. `MINIMAL_AGENT_CONFIG` env var (full path override)
 *   2. `<home>/.minimal-agent/config.jsonc`
 *   3. `<home>/.minimal-agent/config.json` (legacy fallback)
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

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface RawMemorySlice {
  inject?: unknown
  summary?: Record<string, unknown>
}

/**
 * Read and validate the memory slice of the user config.
 *
 * Returns a {@link MemoryConfig} cloned from {@link DEFAULT_MEMORY_CONFIG}
 * for any failure mode (missing file, parse error, wrong types). Never
 * throws.
 *
 * The optional `opts.path` argument is for tests. In production callers
 * pass nothing and {@link memoryConfigPath} is consulted.
 */
export function loadMemoryConfig(
  opts: { path?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): MemoryConfig {
  const path = opts.path ?? memoryConfigPath({ home: opts.home, env: opts.env })
  const raw = readRawMemorySlice(path)
  return resolveMemoryConfig(raw)
}

/**
 * Pure resolver: takes a raw (untrusted) `plugins.memory` slice and
 * returns a fully-defaulted {@link MemoryConfig}. Exported for tests.
 *
 * Back-compat: legacy `summary.enabled === true` with no top-level
 * `inject` field resolves to `inject: "summary"`.
 */
export function resolveMemoryConfig(raw: RawMemorySlice | null): MemoryConfig {
  const cfg: MemoryConfig = {
    inject: DEFAULT_MEMORY_CONFIG.inject,
    summary: { ...DEFAULT_MEMORY_CONFIG.summary },
  }
  if (!raw) return cfg

  // 1. Explicit inject mode (takes precedence over legacy summary.enabled).
  let injectSet = false
  if (typeof raw.inject === "string" && VALID_INJECT_MODES.has(raw.inject as MemoryInjectMode)) {
    cfg.inject = raw.inject as MemoryInjectMode
    injectSet = true
  }

  // 2. Summary sub-slice.
  const s = raw.summary
  if (s && typeof s === "object" && !Array.isArray(s)) {
    // 2a. Back-compat: legacy `summary.enabled: true` implies summary
    //     mode when the explicit knob is unset.
    if (!injectSet && s.enabled === true) {
      cfg.inject = "summary"
    }

    // 2b. Summary params (per-key validation, lenient).
    if (typeof s.model === "string" && s.model.length > 0) {
      cfg.summary.model = s.model
    }
    if (
      typeof s.minBullets === "number" &&
      Number.isFinite(s.minBullets) &&
      s.minBullets >= 0
    ) {
      cfg.summary.minBullets = Math.floor(s.minBullets)
    }
    if (typeof s.minBytes === "number" && Number.isFinite(s.minBytes) && s.minBytes >= 0) {
      cfg.summary.minBytes = Math.floor(s.minBytes)
    }
    if (
      typeof s.dirtyBullets === "number" &&
      Number.isFinite(s.dirtyBullets) &&
      s.dirtyBullets >= 0
    ) {
      cfg.summary.dirtyBullets = Math.floor(s.dirtyBullets)
    }
  }

  return cfg
}

/**
 * Read the raw `plugins.memory` slice from disk. Returns `null` for any
 * failure (no file, bad JSON, missing slice). Pure I/O wrapper around
 * the JSONC parser.
 */
function readRawMemorySlice(path: string): RawMemorySlice | null {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const plugins = (parsed as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return null
  const memSlice = (plugins as Record<string, unknown>).memory
  if (!memSlice || typeof memSlice !== "object" || Array.isArray(memSlice)) return null
  return memSlice as RawMemorySlice
}
