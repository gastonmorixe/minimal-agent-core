/**
 * Diagnostics plugin configuration.
 *
 * Read from `~/.minimal-agent/config.jsonc` under `plugins.diagnostics`, the
 * same guarded raw-read pattern `file-lock` uses. `resolveConfig` is pure over
 * a raw object so it unit-tests without the filesystem; `loadConfig` wires the
 * file read.
 *
 * Defaults are deliberately "types + format, fast": the high-value type signal
 * and the cheap formatter are on; the startup-heavy linter is opt-in.
 *
 * @module plugins/diagnostics/lib/config
 */
import { existsSync, readFileSync } from "node:fs"

import type { FindingSeverity } from "./types.ts"

export interface OutOfScopeConfig {
  /** Run a direct fallback check on files outside the project's include scope. */
  enabled: boolean
}

export interface DiagnosticsConfig {
  enabled: boolean
  /** Run the persistent type provider (tsgo). */
  type: boolean
  /** Run the formatter provider (biome). */
  format: boolean
  /** Run the linter provider (oxlint). Off by default (startup-heavy). */
  lint: boolean
  /** Run the Apple language provider (sourcekit-lsp for Swift/Obj-C/C). Off by default (startup-heavy). */
  apple: boolean
  /** Out-of-scope diagnostics: check files even when excluded by tsconfig/biome/oxlint. */
  outOfScope: OutOfScopeConfig
  /** Minimum severity surfaced to the model + panel. */
  severityFloor: FindingSeverity
  /** Max diagnostics rendered inline / sent to the model. */
  maxInline: number
  /** Per-provider timeout (ms). */
  timeoutMs: number
}

export const DEFAULT_CONFIG: DiagnosticsConfig = {
  enabled: true,
  type: true,
  format: true,
  lint: false,
  apple: true,
  outOfScope: { enabled: true },
  severityFloor: "warning",
  maxInline: 8,
  timeoutMs: 2000,
}

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "info"])

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback
}

function posIntOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** Resolve a raw `plugins.diagnostics` block into a validated config. */
export function resolveConfig(raw: unknown): DiagnosticsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_CONFIG }
  const r = raw as Record<string, unknown>
  const severityFloor =
    typeof r.severityFloor === "string" && SEVERITIES.has(r.severityFloor)
      ? (r.severityFloor as FindingSeverity)
      : DEFAULT_CONFIG.severityFloor
  const outOfScopeRaw = (r.outOfScope as Record<string, unknown> | undefined) ?? {}
  const outOfScope = {
    enabled: boolOr(outOfScopeRaw.enabled, DEFAULT_CONFIG.outOfScope.enabled),
  }
  return {
    enabled: boolOr(r.enabled, DEFAULT_CONFIG.enabled),
    type: boolOr(r.type, DEFAULT_CONFIG.type),
    format: boolOr(r.format, DEFAULT_CONFIG.format),
    lint: boolOr(r.lint, DEFAULT_CONFIG.lint),
    apple: boolOr(r.apple, DEFAULT_CONFIG.apple),
    outOfScope,
    severityFloor,
    maxInline: posIntOr(r.maxInline, DEFAULT_CONFIG.maxInline),
    timeoutMs: posIntOr(r.timeoutMs, DEFAULT_CONFIG.timeoutMs),
  }
}

/**
 * Load + resolve the config from a JSONC file path. Tolerant: a missing or
 * malformed file yields defaults. The env kill-switch
 * `MINIMAL_AGENT_DIAGNOSTICS_DISABLED=1` forces `enabled:false`.
 *
 * `parseJsonc` is injected so the plugin doesn't import the agent's parser; the
 * handler passes a tiny local JSONC-tolerant parse.
 */
export function loadConfig(
  configFilePath: string,
  parse: (raw: string) => unknown,
): DiagnosticsConfig {
  if (process.env.MINIMAL_AGENT_DIAGNOSTICS_DISABLED === "1") {
    return { ...DEFAULT_CONFIG, enabled: false }
  }
  try {
    if (!existsSync(configFilePath)) return { ...DEFAULT_CONFIG }
    const parsed = parse(readFileSync(configFilePath, "utf8"))
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG }
    const plugins = (parsed as Record<string, unknown>).plugins as
      | Record<string, unknown>
      | undefined
    return resolveConfig(plugins?.diagnostics)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
