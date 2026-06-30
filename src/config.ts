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
 * config (logged once to stderr in --debug mode, never fatal).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"

import { parseFormatterCommand } from "./host/ui/formatter/formatter.ts"
import { parseJsonc } from "./jsonc.ts"
import { normalizeSubmittedAtStyle } from "./scrollback-submitted-at.ts"

export interface UserConfig {
  model?: string
  provider?: string
  /** Reasoning effort. Pass-through to `output_config.effort` on the wire;
   *  the server validates. Common values: `"low" | "medium" | "high" | "max"`. */
  effort?: string
  thinkingDisplay?: "summarized" | "omitted"
  spinner?: string
  formatter?: string
  /**
   * Extra args appended to the formatter command after resolution.
   *
   * Useful for opt-in mdstream features (e.g. `["--table-fit"]`) without
   * having to override the executable via `formatter` / `--formatter`.
   * Applied to whichever formatter wins (auto-resolved mdstream, cached
   * binary, or `--formatter <cmd>` override) — the args are appended,
   * not replacing.
   *
   * Accepted shapes in the JSONC file:
   *   "formatterArgs": ["--table-fit"]            // array (preferred)
   *   "formatterArgs": "--table-fit --foo bar"    // shell-style string
   *
   * Override at runtime via `--formatter-args "<args>"` or
   * `MINIMAL_AGENT_FORMATTER_ARGS="<args>"` (both shell-parsed).
   */
  formatterArgs?: string[]
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
  /**
   * First-run plugin bootstrap. When `true` (or unset = default), the agent
   * clones the extended first-party plugins repo
   * (`gastonmorixe/minimal-agent-plugins`) into `~/.minimal-agent/plugins` the
   * first time it boots without that directory populated. Set `false` to never
   * fetch (an offline / locked-down box, or you manage plugins yourself).
   * Override at runtime via `MINIMAL_AGENT_NO_PLUGIN_SYNC=1`. The clone is
   * one-shot: once the directory has plugins it is never auto-pulled.
   */
  pluginSync?: boolean
  /**
   * Override the git remote used by the first-run plugin bootstrap. Defaults
   * to the public `minimal-agent-plugins` repo. Accepts anything `git clone`
   * understands (https URL, ssh URL, local path, `file://`). Override at
   * runtime via `MINIMAL_AGENT_PLUGINS_REPO`.
   */
  pluginsRepo?: string
  /**
   * Show the startup tree (banner + rows + closer). When unset, the
   * default is `true` for interactive sessions and `false` for
   * non-interactive ones (`--prompt`, `-`, bare-positional prompt).
   * Override at runtime via `--header` / `--no-header` or
   * `MINIMAL_AGENT_HEADER=0|1`.
   */
  header?: boolean
  /**
   * Initial mode id (e.g. `"ask"`). Use `"none"` to force no mode even
   * when the default would pick one. Override via `--mode <id>` or
   * `MINIMAL_AGENT_MODE`. Default: `"ask"` for non-interactive,
   * plugin-declared default for interactive.
   */
  mode?: string
  /**
   * Opt-in per-session agent name, surfaced as one line in the system
   * prompt (e.g. "You are working as Laura."). Off by default.
   *
   *   - a literal like `"Laura"` names the agent that, every session;
   *   - `"auto"` derives a STABLE name from the session id (so a fleet of
   *     sub-agents gets distinct, resume-stable names with no config);
   *   - `"off"` / `"none"` (or omitting the key) disables naming.
   *
   * Override at runtime via `MINIMAL_AGENT_AGENT_NAME` (which also accepts
   * `auto` / a literal / `off`, and takes precedence over this value).
   */
  agentName?: string
  /**
   * Visual cell width of a Nerd Font PUA glyph in the user's terminal,
   * used to size the gap between the spinner icon and the label on the
   * live-area status row. PUA codepoints are UAX-#11 "Ambiguous"; each
   * terminal + font config picks 1 or 2.
   *
   *   - `1`      : force 1-cell PUA width (unpatched fallback font).
   *   - `2`      : force 2-cell PUA width (patched Nerd Font).
   *   - `"auto"` : probe at startup via cursor-position-report; falls
   *                back to `1` on probe failure / non-TTY / inside tmux.
   *
   * Default: `"auto"`. Override at runtime via env
   * `MINIMAL_AGENT_NERD_GLYPH_CELLS=1|2|auto`.
   */
  nerdGlyphCells?: 1 | 2 | "auto"
  /**
   * Status-bar (quota footer) customization. Declarative; provider-aware.
   *
   * `"statusBar": { "segments": ["context", "quota", "model", "sid"] }`
   *
   * `segments` is the ordered list of segments to render. Valid ids:
   *   - `"quota"`   : the provider's plan/rate-limit windows (5h, 7d, …).
   *   - `"context"` : the session context-usage bar.
   *   - `"model"`   : the `<provider-model>:<effort>` tag.
   *   - `"sid"`     : the short session-id anchor.
   *
   * Reorder to taste; omit ids to hide them. Unknown ids are ignored; an
   * empty/all-invalid list falls back to the default order
   * (`["quota","context","model","sid"]`). A segment with no data for the
   * current provider (e.g. `quota` on a provider with no quota concept)
   * renders nothing even when listed.
   *
   * For full control, `script` names an executable/command the quota-status
   * plugin runs each refresh: it receives the session metadata as JSON on stdin
   * and its stdout's first line becomes the footer. On any failure/timeout/empty
   * output the built-in renderer is used, so a broken script never blanks the
   * footer. When `script` is set it takes precedence over `segments`.
   */
  statusBar?: {
    segments?: string[]
    script?: string
  }
  /**
   * Scrollback customization for submitted user prompts.
   *
   * `submittedAt: "inline-locale"` prefixes submitted prompts with a dim,
   * locale-native timestamp. `false` or `"off"` disables it.
   */
  scrollback?: {
    submittedAt?: false | "off" | "inline-locale"
  }
}

const VALID_DISPLAY = new Set(["summarized", "omitted"])

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
  if (typeof obj.provider === "string" && obj.provider.length > 0) out.provider = obj.provider
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
  // formatterArgs accepts either a string[] (preferred) or a shell-style
  // string (parsed via parseFormatterCommand). Empty / non-string entries
  // in an array are dropped silently. Any other shape → ignored.
  if (Array.isArray(obj.formatterArgs)) {
    const arr = obj.formatterArgs.filter((a): a is string => typeof a === "string" && a.length > 0)
    if (arr.length > 0) out.formatterArgs = arr
  } else if (typeof obj.formatterArgs === "string" && obj.formatterArgs.length > 0) {
    const parsed = parseFormatterCommand(obj.formatterArgs)
    if (parsed.length > 0) out.formatterArgs = parsed
  }
  if (typeof obj.autoAsk === "boolean") out.autoAsk = obj.autoAsk
  if (typeof obj.skipQuota === "boolean") out.skipQuota = obj.skipQuota
  if (typeof obj.pluginSync === "boolean") out.pluginSync = obj.pluginSync
  if (typeof obj.pluginsRepo === "string" && obj.pluginsRepo.length > 0) {
    out.pluginsRepo = obj.pluginsRepo
  }
  if (typeof obj.header === "boolean") out.header = obj.header
  if (typeof obj.mode === "string" && obj.mode.length > 0) out.mode = obj.mode
  // agentName: any non-empty string (a literal, "auto", or an off sentinel).
  // The resolver in `agent-name.ts` interprets the value; here we only
  // shape-check and pass it through.
  if (typeof obj.agentName === "string" && obj.agentName.trim().length > 0) {
    out.agentName = obj.agentName.trim()
  }
  // nerdGlyphCells: literal 1 or 2 numbers, or string "auto". Anything else
  // (including "1" / "2" as strings) is rejected to keep the surface tight.
  if (obj.nerdGlyphCells === 1 || obj.nerdGlyphCells === 2) {
    out.nerdGlyphCells = obj.nerdGlyphCells
  } else if (obj.nerdGlyphCells === "auto") {
    out.nerdGlyphCells = "auto"
  }
  // statusBar.segments: an array of segment-id strings (shape-check only; the
  // renderer's `normalizeSegmentOrder` is the lenient authority on valid ids).
  // statusBar.script: a non-empty command string (full-custom renderer).
  if (obj.statusBar && typeof obj.statusBar === "object" && !Array.isArray(obj.statusBar)) {
    const sb = obj.statusBar as Record<string, unknown>
    const statusBar: { segments?: string[]; script?: string } = {}
    if (Array.isArray(sb.segments)) {
      const segs = sb.segments.filter((s): s is string => typeof s === "string" && s.length > 0)
      if (segs.length > 0) statusBar.segments = segs
    }
    if (typeof sb.script === "string" && sb.script.trim().length > 0) {
      statusBar.script = sb.script
    }
    if (statusBar.segments || statusBar.script) out.statusBar = statusBar
  }
  if (obj.scrollback && typeof obj.scrollback === "object" && !Array.isArray(obj.scrollback)) {
    const sb = obj.scrollback as Record<string, unknown>
    const submittedAt = normalizeSubmittedAtStyle(sb.submittedAt)
    if (submittedAt !== undefined) out.scrollback = { submittedAt }
  }
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
