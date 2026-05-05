/**
 * Global user config at `~/.minimal-agent/config.jsonc` (preferred) or
 * `~/.minimal-agent/config.json` (legacy fallback).
 *
 * The `.jsonc` form supports `// line comments`, block comments, and
 * trailing commas — useful for documenting choices in-place.
 *
 * Optional. When present, values fill in defaults for CLI flags / env
 * vars. Precedence (highest wins):
 *
 *   CLI flag  >  env var  >  config file  >  built-in default
 *
 * Example `~/.minimal-agent/config.jsonc`:
 *
 *   {
 *     // The 1M-context Opus flavor — the [1m] suffix activates the beta.
 *     "model": "claude-opus-4-7[1m]",
 *
 *     // Required to see plaintext thinking on Opus 4.7 (server default
 *     // is "omitted" — only encrypted signatures stream otherwise).
 *     "thinkingDisplay": "summarized",
 *
 *     "effort": "high",
 *   }
 *
 * Unknown keys are ignored. Malformed file or unreadable file → empty
 * config (logged once to stderr in --debug mode, never fatal).
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseJsonc } from "./jsonc.ts"

export interface UserConfig {
  model?: string
  /** Reasoning effort. Pass-through to `output_config.effort` on the wire;
   *  the server validates. Common values: `"low" | "medium" | "high" | "max"`. */
  effort?: string
  thinkingDisplay?: "summarized" | "omitted"
  spinner?: string
  formatter?: string
  /**
   * Auto-ASK heuristic. When `true` (or unset = default), the editor's
   * input stream is scored for question-vs-action intent and the agent
   * silently flips into ASK mode on confident questions, reverting on
   * confident actions. Set `false` to disable. Override at runtime via
   * `MINIMAL_AGENT_AUTO_ASK=0`.
   */
  autoAsk?: boolean
  /**
   * Skip the startup quota check.
   */
  skipQuota?: boolean
}

const VALID_DISPLAY = new Set(["summarized", "omitted"])

/**
 * Resolve the config path. Override via `MINIMAL_AGENT_CONFIG` (used by
 * tests and power users). When unset, prefers `~/.minimal-agent/config.jsonc`
 * if it exists, falling back to `~/.minimal-agent/config.json`.
 */
export function configPath(): string {
  if (process.env.MINIMAL_AGENT_CONFIG) return process.env.MINIMAL_AGENT_CONFIG
  const dir = join(homedir(), ".minimal-agent")
  const jsoncPath = join(dir, "config.jsonc")
  if (existsSync(jsoncPath)) return jsoncPath
  return join(dir, "config.json")
}

/**
 * Read and validate `~/.minimal-agent/config.json`. Returns `{}` for any
 * failure mode (missing file, parse error, wrong types) — never throws.
 *
 * Validation is lenient: unknown keys are dropped, invalid enum values
 * are dropped (with a debug-mode warning), valid keys pass through.
 */
export function loadUserConfig(): UserConfig {
  const path = configPath()
  if (!existsSync(path)) return {}

  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    // Always parse via JSONC — plain JSON is a strict subset, so this
    // works for both `.json` and `.jsonc` files transparently.
    parsed = parseJsonc(raw)
  } catch (err) {
    if (process.env.DEBUG === "1") {
      console.error(`[config] ${path}: parse error: ${(err as Error).message}`)
    }
    return {}
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  const out: UserConfig = {}

  if (typeof obj.model === "string" && obj.model.length > 0) out.model = obj.model
  // Effort is pass-through: any non-empty string forwards to the server,
  // which is the source of truth on accepted levels.
  if (typeof obj.effort === "string" && obj.effort.length > 0) {
    out.effort = obj.effort
  }
  if (typeof obj.thinkingDisplay === "string" && VALID_DISPLAY.has(obj.thinkingDisplay)) {
    out.thinkingDisplay = obj.thinkingDisplay as UserConfig["thinkingDisplay"]
  }
  if (typeof obj.spinner === "string" && obj.spinner.length > 0) out.spinner = obj.spinner
  if (typeof obj.formatter === "string" && obj.formatter.length > 0) out.formatter = obj.formatter
  if (typeof obj.autoAsk === "boolean") out.autoAsk = obj.autoAsk
  if (typeof obj.skipQuota === "boolean") out.skipQuota = obj.skipQuota

  return out
}

/**
 * Walk `plugins.<id>.enabled` in the user config and collect the ids of
 * any plugin that has been explicitly disabled (`enabled: false`).
 *
 * The caller (typically `src/index.ts`) passes the resulting set as
 * `disabledPluginIds` to `PluginLoader.load`, where the loader skips
 * matching packages before validation. This gives every plugin a uniform
 * opt-out without each one having to implement disabling itself.
 *
 * Lenient: missing file, missing `plugins` section, malformed JSON, or
 * non-object plugin blocks → empty set. Never throws.
 *
 * Note: a plugin block that is *missing* `enabled`, or has any value
 * other than literal `false`, is treated as ENABLED. Only the explicit
 * `false` opts the plugin out — config presence alone never disables.
 */
export function loadDisabledPluginIds(): Set<string> {
  const path = configPath()
  const out = new Set<string>()
  if (!existsSync(path)) return out
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return out
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out
  const plugins = (parsed as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return out
  for (const [id, block] of Object.entries(plugins as Record<string, unknown>)) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue
    if ((block as Record<string, unknown>).enabled === false) out.add(id)
  }
  return out
}
