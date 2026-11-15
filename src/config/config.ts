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
 * `CLI flag > env var > config file > built-in default`
 *
 * Example `~/.minimal-agent/config.jsonc` (model ids come from the
 * provider plugins' registries — `--list-models` shows the catalog; the
 * `[1m]` suffix is the client-side 1M-context opt-in convention):
 *
 * ```jsonc
 * {
 *   "model": "<model-id>[1m]",
 *   "provider": "<provider-id>",
 *
 *   // Show plaintext/summarized thinking when the model's server
 *   // default streams only encrypted signatures.
 *   "thinkingDisplay": "summarized",
 *
 *   "effort": "high",
 * }
 * ```
 *
 * Unknown keys are ignored. Malformed file or unreadable file → empty
 * config, never fatal. A parse error is a Debug-severity diagnostic.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"

import { Severity } from "../bus/diagnostic-bus.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
import { emitTyped } from "../diagnostics/typed.ts"
import type { PluginPromptsConfigValue } from "../plugins/plugin-prompt-resolution.ts"
import { parseJsonc } from "../utils/jsonc.ts"

import { SYSTEM_PROMPT_OVERRIDE_KEY_SPECS } from "./system-prompt-override-keys.ts"

export interface SystemPromptUserConfig {
  full?: string | false | null
  fullFile?: string
  identity?: string | false | null
  identityFile?: string
  providerPreamble?: string | false | null
  providerPreambleFile?: string
  instructions?: string | false | null
  instructionsFile?: string
  loopSafety?: string | false | null
  loopSafetyFile?: string
  toolOutputConventions?: string | false | null
  toolOutputConventionsFile?: string
  sessionContext?: string | false | null
  sessionContextFile?: string
  unsafeProviderOverrides?: boolean
}

export interface UserConfig {
  model?: string
  provider?: string
  /** Generic endpoint URL. Used by provider `generic-endpoint`. */
  endpoint?: string
  /** Generic endpoint surface id, e.g. `openai-chat-completions`. */
  format?: string
  /** Generic endpoint auth mode. */
  authType?: "api-key" | "bearer" | "none" | "custom-header"
  /** API key or bearer token for a generic endpoint. */
  apiKey?: string
  /** Header name for `authType: "custom-header"`. */
  authHeader?: string
  /** Wire model id to send to a generic endpoint, separate from local `model`. */
  providerModel?: string
  /**
   * Effort levels a generic endpoint ad-hoc model advertises, so `--effort`
   * is accepted for a runtime-configured backend (e.g. `["low","medium","high"]`).
   */
  effortLevels?: string[]
  /**
   * Credential name to use for the selected provider. When the provider has
   * multiple stored credentials (e.g. "Work" and "Personal"), this selects
   * which one to use. Omit to use the provider's default displayName.
   */
  credentialName?: string
  /** Reasoning effort. Pass-through to `output_config.effort` on the wire;
   *  the server validates. Common values: `"low" | "medium" | "high" | "max"`. */
  effort?: string
  thinkingDisplay?: "summarized" | "omitted"
  /**
   * Prompt-cache TTL bucket for the agent's cache breakpoints. One of
   * `"5m"` (default) or `"1h"` — the two buckets Anthropic's
   * `cache_control.ttl` accepts. A longer TTL keeps the cached prefix warm
   * across slower turn cadences at a higher cache-write cost. Override at
   * runtime via `--cache-ttl <5m|1h>` or `MINIMAL_AGENT_CACHE_TTL`.
   */
  cacheTtl?: "5m" | "1h"
  /**
   * Mirror every raw HTTP request/response to `~/.minimal-agent/net-dbg/`.
   * Same switch as `MINIMAL_AGENT_NET_DBG=1`; the env var wins when set
   * (`1` forces on, `0` forces off). Read once at process start. The logs
   * hold plaintext `authorization` headers, so treat the folder as secret.
   */
  netDbg?: boolean
  /**
   * Retention for the `net-dbg/` folder, applied once per process in the
   * background when capture is on. `maxAgeDays` (default 7) drops session
   * folders older than that; `maxTotalMB` (default 2048) then drops the
   * oldest until the rest fit. `0` turns a limit off. The current session's
   * folder is never deleted.
   */
  netDbgRetention?: { maxAgeDays?: number; maxTotalMB?: number }
  systemPrompt?: SystemPromptUserConfig
  /**
   * First-run plugin bootstrap. When `true` (or unset = default), the host
   * clones the first-party plugins repo into its plugin sync dir the first
   * time it boots without that directory populated. Set `false` to never
   * fetch (an offline / locked-down box, or you manage plugins yourself).
   * Override at runtime via `MINIMAL_AGENT_NO_PLUGIN_SYNC=1`. The clone is
   * one-shot: once the directory has plugins it is never auto-pulled.
   */
  pluginSync?: boolean
  /**
   * Override the git remote used by the first-run plugin bootstrap. The
   * host names the default repo. Accepts anything `git clone`
   * understands (https URL, ssh URL, local path, `file://`). Override at
   * runtime via `MINIMAL_AGENT_PLUGINS_REPO`.
   */
  pluginsRepo?: string
  /**
   * Initial mode id (e.g. `"ask"`). Use `"none"` to force no mode even
   * when the default would pick one. Override via `--mode <id>` or
   * `MINIMAL_AGENT_MODE`. Default: `"ask"` for non-interactive,
   * plugin-declared default for interactive.
   */
  mode?: string
  /**
   * Per-session agent name, surfaced as one line in the system
   * prompt (e.g. "You are working as Laura."). On by default: when the key
   * is omitted the resolver behaves as `"auto"`.
   *
   *   - a literal like `"Laura"` names the agent that, every session;
   *   - `"auto"` (the default) derives a STABLE name from the session id (so
   *     a fleet of sub-agents gets distinct, resume-stable names with no
   *     config);
   *   - `"off"` / `"none"` disables naming (the only way to opt out).
   *
   * Override at runtime via `MINIMAL_AGENT_AGENT_NAME` (which also accepts
   * `auto` / a literal / `off`, and takes precedence over this value).
   */
  agentName?: string
  /**
   * The `plugins` section of the config file. It holds two different
   * things, and they share one namespace:
   *
   *   - `plugins.<id>.enabled` per-plugin enable/disable. Read by
   *     {@link loadPluginEnabledOverrides}.
   *   - `plugins.prompts` prompt-text suppression (`false`, `true`, or
   *     `{ all?, keep?, suppress? }`). Read by
   *     {@link loadPluginPromptsConfig}.
   *
   * Only the `prompts` key is modeled here. The per-plugin enable walk is
   * independent (it reads the raw file), so `plugins.prompts` is read as
   * this feature only when the value is a boolean or an object without an
   * `enabled` key. See {@link loadPluginPromptsConfig}.
   */
  plugins?: {
    prompts?: PluginPromptsConfigValue | boolean
  }
}

const VALID_DISPLAY = new Set(["summarized", "omitted"])
const VALID_CACHE_TTL = new Set(["5m", "1h"])

/**
 * Resolve the config path. Override via `MINIMAL_AGENT_CONFIG` (used by
 * tests and power users). When unset, prefers `~/.minimal-agent/config.jsonc`
 * if it exists, falling back to `~/.minimal-agent/config.json`.
 */
export function configPath(): string {
  if (process.env.MINIMAL_AGENT_CONFIG) return process.env.MINIMAL_AGENT_CONFIG
  const dir = resolveAgentHome()
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
function parseSystemPromptUserConfig(obj: Record<string, unknown>): SystemPromptUserConfig {
  const out: SystemPromptUserConfig = {}
  for (const spec of SYSTEM_PROMPT_OVERRIDE_KEY_SPECS) {
    const value = obj[spec.configKey]
    if (typeof value === "string" || value === false || value === null) {
      out[spec.configKey as keyof SystemPromptUserConfig] = value as never
    }
    const fileValue = obj[spec.configFileKey]
    if (typeof fileValue === "string") {
      out[spec.configFileKey as keyof SystemPromptUserConfig] = fileValue as never
    }
  }
  if (typeof obj.unsafeProviderOverrides === "boolean") {
    out.unsafeProviderOverrides = obj.unsafeProviderOverrides
  }
  return out
}

/**
 * Load and parse the user config file from disk.
 *
 * Returns an empty config when the file is absent or cannot be read/parsed,
 * so callers can always treat the result as a valid (possibly empty) config.
 */
export function loadUserConfig(diagnostics: Diagnostics = processDiagnostics()): UserConfig {
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
    emitTyped(
      diagnostics,
      Severity.Debug,
      "config.parse-error",
      `${path}: ${(err as Error).message}`,
      {
        path,
        detail: (err as Error).message,
      },
    )
    return {}
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const obj = parsed as Record<string, unknown>
  const out: UserConfig = {}

  if (typeof obj.model === "string" && obj.model.length > 0) out.model = obj.model
  if (typeof obj.provider === "string" && obj.provider.length > 0) out.provider = obj.provider
  if (typeof obj.credentialName === "string" && obj.credentialName.length > 0) {
    out.credentialName = obj.credentialName
  }
  // Effort is pass-through: any non-empty string forwards to the server,
  // which is the source of truth on accepted levels.
  if (typeof obj.effort === "string" && obj.effort.length > 0) {
    out.effort = obj.effort
  }
  if (typeof obj.thinkingDisplay === "string" && VALID_DISPLAY.has(obj.thinkingDisplay)) {
    out.thinkingDisplay = obj.thinkingDisplay as UserConfig["thinkingDisplay"]
  }
  if (typeof obj.cacheTtl === "string" && VALID_CACHE_TTL.has(obj.cacheTtl)) {
    out.cacheTtl = obj.cacheTtl as UserConfig["cacheTtl"]
  }
  if (
    obj.systemPrompt &&
    typeof obj.systemPrompt === "object" &&
    !Array.isArray(obj.systemPrompt)
  ) {
    const systemPrompt = parseSystemPromptUserConfig(obj.systemPrompt as Record<string, unknown>)
    if (Object.keys(systemPrompt).length > 0) out.systemPrompt = systemPrompt
  }
  if (typeof obj.netDbg === "boolean") out.netDbg = obj.netDbg
  if (obj.netDbgRetention && typeof obj.netDbgRetention === "object") {
    const r = obj.netDbgRetention as Record<string, unknown>
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
    const maxAgeDays = num(r.maxAgeDays)
    const maxTotalMB = num(r.maxTotalMB)
    out.netDbgRetention = {
      ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
      ...(maxTotalMB !== undefined ? { maxTotalMB } : {}),
    }
  }
  if (typeof obj.pluginSync === "boolean") out.pluginSync = obj.pluginSync
  if (typeof obj.pluginsRepo === "string" && obj.pluginsRepo.length > 0) {
    out.pluginsRepo = obj.pluginsRepo
  }
  if (typeof obj.mode === "string" && obj.mode.length > 0) out.mode = obj.mode
  // agentName: any non-empty string (a literal, "auto", or an off sentinel).
  // The resolver in `agent-name.ts` interprets the value; here we only
  // shape-check and pass it through.
  if (typeof obj.agentName === "string" && obj.agentName.trim().length > 0) {
    out.agentName = obj.agentName.trim()
  }
  // Terminal-only keys (spinner, formatter, formatterArgs, header, autoAsk,
  // skipQuota, nerdGlyphCells, scrollback) are read by the CLI
  // (minimal-agent-cli src/config/terminal-config.ts). `statusBar` is read by
  // the quota-status plugin. Core drops them like any unknown key.
  // `plugins.prompts` is the prompt-suppression setting, NOT a plugin block
  // (see loadPluginPromptsConfig for the disambiguation rule).
  const pluginsRaw = obj.plugins
  if (pluginsRaw && typeof pluginsRaw === "object" && !Array.isArray(pluginsRaw)) {
    const prompts = parsePluginPromptsValue((pluginsRaw as Record<string, unknown>).prompts)
    if (prompts !== undefined) out.plugins = { prompts }
  }
  return out
}

/**
 * Walk `plugins.<id>.enabled` in the user config and collect the ids of
 * any plugin that has been explicitly disabled (`enabled: false`).
 *
 * The caller (typically the host entry point) passes the resulting set as
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
  return loadPluginEnabledOverrides().forceDisabled
}

/**
 * Walk `plugins.<id>.enabled` in the user config and collect the ids of
 * any plugin that has been explicitly enabled (`enabled: true`).
 *
 * The loader uses this as an OVERRIDE for the manifest-level
 * `enabled: false` opt-out: a plugin whose author shipped it disabled
 * comes back online if the user adds
 * `{ "plugins": { "<id>": { "enabled": true } } }` to their config.
 *
 * Lenient: missing file, missing `plugins` section, malformed JSON, or
 * non-object plugin blocks → empty set. Never throws.
 *
 * Note: a plugin block that is *missing* `enabled`, or has any value
 * other than literal `true`, is NOT recorded here. Only the explicit
 * `true` is an override signal.
 */
export function loadEnabledPluginIds(): Set<string> {
  return loadPluginEnabledOverrides().forceEnabled
}

/**
 * Single config walk that returns BOTH the explicit-disable and
 * explicit-enable sets. Cheaper than calling the two individual
 * helpers when both are needed.
 */
export function loadPluginEnabledOverrides(): {
  forceDisabled: Set<string>
  forceEnabled: Set<string>
} {
  const forceDisabled = new Set<string>()
  const forceEnabled = new Set<string>()
  const path = configPath()
  if (!existsSync(path)) return { forceDisabled, forceEnabled }
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return { forceDisabled, forceEnabled }
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch {
    return { forceDisabled, forceEnabled }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { forceDisabled, forceEnabled }
  }
  const plugins = (parsed as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return { forceDisabled, forceEnabled }
  }
  for (const [id, block] of Object.entries(plugins as Record<string, unknown>)) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue
    const enabled = (block as Record<string, unknown>).enabled
    if (enabled === false) forceDisabled.add(id)
    else if (enabled === true) forceEnabled.add(id)
  }
  return { forceDisabled, forceEnabled }
}

/**
 * Read the `plugins.prompts` prompt-suppression setting from the user
 * config file: `false`, `true`, a `{ all?, keep?, suppress? }` object, or
 * `undefined` when the key is absent or unusable.
 *
 * DISAMBIGUATION: `plugins` is also the per-plugin enable namespace
 * (`plugins.<id>.enabled`). The value counts as this feature only when it is
 * a boolean, or an object whose keys are a subset of
 * `{all, keep, suppress}` and which has NO `enabled` key. Anything else is a
 * plugin block, so this returns `undefined` and the loader/manifest side
 * reports the reserved id (`prompts`). See {@link UserConfig.plugins}.
 *
 * Lenient like the other config readers: a missing file, bad JSON, or a
 * wrong type returns `undefined`. Never throws.
 */
export function loadPluginPromptsConfig(): PluginPromptsConfigValue | boolean | undefined {
  const path = configPath()
  if (!existsSync(path)) return undefined
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const plugins = (parsed as Record<string, unknown>).plugins
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return undefined
  return parsePluginPromptsValue((plugins as Record<string, unknown>).prompts)
}

/**
 * Shape-check a raw `plugins.prompts` value. Returns the boolean, the
 * normalized object, or `undefined` when the value is a plugin block or of
 * an unusable type. See {@link loadPluginPromptsConfig}.
 */
function parsePluginPromptsValue(raw: unknown): PluginPromptsConfigValue | boolean | undefined {
  if (typeof raw === "boolean") return raw
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  if (obj.enabled !== undefined) return undefined
  const allowed = new Set(["all", "keep", "suppress"])
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return undefined
  }
  const out: { all?: boolean; keep?: readonly string[]; suppress?: readonly string[] } = {}
  if (typeof obj.all === "boolean") out.all = obj.all
  const keep = stringList(obj.keep)
  if (keep.length > 0) out.keep = keep
  const suppress = stringList(obj.suppress)
  if (suppress.length > 0) out.suppress = suppress
  return out
}

/** Keep only the non-empty strings of a list. A non-array yields `[]`. */
function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of raw) {
    if (typeof value === "string" && value.trim().length > 0) out.push(value.trim())
  }
  return out
}

/**
 * Per-mode user override: just the permissions slice for now (allow +
 * deny). Mirrors `ModePermissions` from `src/plugins/types.ts` but
 * defined here so `src/config.ts` doesn't import from the plugins
 * layer (the dependency would point the wrong way).
 */
export interface ModeUserOverrideConfig {
  permissions?: {
    allow?: string[]
    deny?: string[]
  }
}

/**
 * Walk `plugins.<plugin-id>.modes.<mode-id>` in the user config and
 * return a `Map<mode-id, override>`.
 *
 * Mode ids are globally unique within a session (the plugin loader
 * rejects duplicates), so the plugin namespace is only a filing
 * cabinet : we collapse everything into a flat `mode-id → override`
 * map keyed by id. If a user accidentally declares the same mode
 * override under two different plugin namespaces, the LAST one wins
 * (Object.entries iteration order = insertion order).
 *
 * Lenient: any malformed entry is silently dropped. Empty file,
 * missing `plugins` section, missing `modes` section, missing
 * `permissions`, wrong types : all return an empty map. Never throws.
 *
 * @example User config:
 *
 * ```jsonc
 * {
 *   "plugins": {
 *     "ask-mode": {
 *       "modes": {
 *         "ask": {
 *           "permissions": {
 *             "allow": ["*"],
 *             "deny":  ["Edit", "Write", "Bash"]
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Returns `Map { "ask" => { permissions: { allow: ["*"], deny: [...] } } }`.
 */
export function loadModeUserOverrides(): Map<string, ModeUserOverrideConfig> {
  const path = configPath()
  const out = new Map<string, ModeUserOverrideConfig>()
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

  for (const block of Object.values(plugins as Record<string, unknown>)) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue
    const modes = (block as Record<string, unknown>).modes
    if (!modes || typeof modes !== "object" || Array.isArray(modes)) continue
    for (const [modeId, modeBlock] of Object.entries(modes as Record<string, unknown>)) {
      if (typeof modeId !== "string" || modeId.length === 0) continue
      if (!modeBlock || typeof modeBlock !== "object" || Array.isArray(modeBlock)) continue
      const permsRaw = (modeBlock as Record<string, unknown>).permissions
      if (!permsRaw || typeof permsRaw !== "object" || Array.isArray(permsRaw)) continue
      const allow = sanitizeToolList((permsRaw as Record<string, unknown>).allow)
      const deny = sanitizeToolList((permsRaw as Record<string, unknown>).deny)
      // Skip entries that contributed nothing usable.
      if (allow == null && deny == null) continue
      const override: ModeUserOverrideConfig = { permissions: {} }
      if (allow != null) override.permissions!.allow = allow
      if (deny != null) override.permissions!.deny = deny
      out.set(modeId, override)
    }
  }
  return out
}

/** Validate one allow/deny list. Returns `null` for missing/unusable. */
function sanitizeToolList(raw: unknown): string[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw)) return null
  const filtered = raw.filter((s): s is string => typeof s === "string" && s.length > 0)
  // An explicit empty array is meaningful (e.g. `deny: []` to undo a
  // manifest-level deny). So we return [], not null, when the user
  // wrote an array : we only filter out non-string entries.
  return filtered
}
