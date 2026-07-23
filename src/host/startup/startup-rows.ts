/**
 * Startup-tree row rendering for the resolved request configuration.
 *
 * Prints the "model / service tier / thinking / effort / cache ttl" rows of
 * the startup banner from the already-resolved CLI options. Pure presentation
 * lifted out of `src/index.ts`: it reads resolved values and calls
 * `printStartupRow`, computing each row's provenance label (which source won
 * the precedence ladder) so the banner shows where each setting came from.
 *
 * @module host/startup/startup-rows
 */

import { c } from "../../agent/agent.ts"
import type { CacheTtlSource } from "../../cache/cache-ttl.ts"
import { type EffortSource, validateEffortForModel } from "../../config/effort-resolution.ts"
import { findModel, findModelForProvider } from "../../llm/model-registry.ts"
import { printStartupRow } from "../ui/startup/tree.ts"

import { modelHidesReasoning } from "./provider-presentation.ts"

/** The subset of a stdout stream the terminal-viewport row reads. */
export interface StdoutSize {
  readonly columns?: number
  readonly rows?: number
}

/** The resolved request-config values the config rows display. */
export interface StartupConfigRows {
  readonly selectedModel: string
  readonly speedFast: boolean
  readonly serviceTier: string | undefined
  readonly thinkingDisplay: "summarized" | "omitted" | undefined
  readonly effort: string | undefined
  readonly effortSource: EffortSource | undefined
  readonly cacheTtl: string
  readonly cacheTtlSource: CacheTtlSource
}

/** Render the `(source)` provenance suffix for an effort value. */
function effortProvenance(source: EffortSource | undefined): string {
  if (source === "cli") return "(--effort)"
  if (source === "env") return "(env)"
  if (source === "config") return "(config)"
  return ""
}

/** Render the `(source)` provenance suffix for a cache-ttl value. */
function cacheTtlProvenance(source: CacheTtlSource): string {
  if (source === "cli") return "(--cache-ttl)"
  if (source === "env") return "(env)"
  if (source === "config") return "(config)"
  return "(default)"
}

/**
 * Print the model / service-tier / thinking / effort / cache-ttl startup rows.
 *
 * @param cfg - The resolved request configuration.
 */
export function printStartupConfigRows(cfg: StartupConfigRows): void {
  // Fast mode gets a ⚡ on the model row so the premium dispatch tier is
  // visible at a glance. Capability-gated per provider downstream; the bolt
  // reflects the resolved request intent, not whether the model honors it.
  printStartupRow(
    "model",
    cfg.speedFast
      ? `${c.boldCyan(cfg.selectedModel)} ${c.boldYellow("⚡ fast")}`
      : c.boldCyan(cfg.selectedModel),
  )
  if (cfg.serviceTier) {
    printStartupRow("service tier", `${cfg.serviceTier} ${c.dim("(provider-mapped)")}`)
  }

  // Thinking + effort: surface what we'll actually send on the wire. A
  // cheap/fast-tier model that supports neither gets "off" for both. This is
  // a capability-driven test (registry flags), not a name-substring match.
  const hidesReasoning = modelHidesReasoning(cfg.selectedModel)
  const thinkingLabel = hidesReasoning
    ? c.dim("off")
    : cfg.thinkingDisplay
      ? `adaptive ${c.dim(`(display=${cfg.thinkingDisplay})`)}`
      : "adaptive"
  const effortLabel = hidesReasoning
    ? c.dim("off")
    : cfg.effort
      ? `${cfg.effort} ${c.dim(effortProvenance(cfg.effortSource))}`
      : `medium ${c.dim("(default)")}`
  printStartupRow("thinking", thinkingLabel)
  printStartupRow("effort", effortLabel)
  printStartupRow("cache ttl", `${cfg.cacheTtl} ${c.dim(cacheTtlProvenance(cfg.cacheTtlSource))}`)
}

/**
 * Validate the resolved effort against the selected model's declared
 * capability levels, so a misconfigured effort fails fast with a clear
 * message instead of a cryptic "unsupported capabilities: effort" on the
 * first request. No-op for models that hide reasoning.
 *
 * When `providerId` is set, lookup is **provider-scoped** via
 * {@link findModelForProvider}. Dual-registered bare ids (e.g. `grok-4.5`
 * under both `grok` and `opencode`) must not validate against the wrong
 * catalog: unscoped last-write-wins made subagent children with
 * `--provider grok --effort low` die because OpenCode's caps
 * (`medium|high|max`) overwrote first-party grok (`low|medium|high`).
 *
 * @param hidesReasoning - Whether the model hides reasoning (skip if true).
 * @param selectedModelBase - The base model id to look up in the registry.
 * @param effort - The resolved effort value (may be undefined).
 * @param providerId - Optional selected provider; scopes the registry lookup.
 * @throws If the effort is not among the model's declared levels.
 */
export function validateStartupEffort(
  hidesReasoning: boolean,
  selectedModelBase: string,
  effort: string | undefined,
  providerId?: string,
): void {
  if (hidesReasoning) return
  const modelEntry = providerId
    ? (findModelForProvider(selectedModelBase, providerId) ?? findModel(selectedModelBase))
    : findModel(selectedModelBase)
  if (!modelEntry) return
  const validation = validateEffortForModel(effort, modelEntry.capabilities.effort.levels)
  if (!validation.ok) throw new Error(validation.reason)
}

/**
 * Publish the RESOLVED effort + fast-mode state into `process.env` as the
 * authoritative OUTPUT ("what we'll actually send on the wire"), overwriting
 * the user-facing INPUT env vars read during resolution. The live-area
 * quota-status plugin and session-info footer read these, so one source of
 * truth after this point. A model that hides reasoning clears the effort var
 * (the wire field is suppressed, so the footer must not claim one).
 *
 * @param hidesReasoning - Whether the model suppresses reasoning fields.
 * @param effort - The resolved effort (defaults to "medium" when reasoning).
 * @param speedFast - Whether fast mode is engaged.
 */
export function publishResolvedRequestEnv(
  hidesReasoning: boolean,
  effort: string | undefined,
  speedFast: boolean,
): void {
  if (hidesReasoning) {
    delete process.env.MINIMAL_AGENT_EFFORT
  } else {
    process.env.MINIMAL_AGENT_EFFORT = effort ?? "medium"
  }
  if (speedFast) {
    process.env.MINIMAL_AGENT_FAST = "1"
  } else {
    delete process.env.MINIMAL_AGENT_FAST
  }
}

/**
 * Print the terminal-viewport (`cols × rows`) startup row.
 *
 * Mirrors `Compositor.effectiveColumns()`: falls back to `$COLUMNS`/`$LINES`
 * when stdout reports 0/undefined (e.g. macOS BSD `script(1)` allocating a
 * slave PTY without propagating WINSZ). Surfacing it at boot makes size
 * surprises visible before they cause wrap artifacts.
 *
 * @param env - The process environment (reads `COLUMNS`/`LINES`).
 * @param stdout - The stdout stream, read for its `columns`/`rows`.
 */
export function printTerminalViewportRow(
  env: Record<string, string | undefined>,
  stdout: StdoutSize,
): void {
  const envCols = Number.parseInt(env.COLUMNS ?? "", 10)
  const envRows = Number.parseInt(env.LINES ?? "", 10)
  const effCols =
    typeof stdout.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : Number.isFinite(envCols) && envCols > 0
        ? envCols
        : 0
  const effRows =
    typeof stdout.rows === "number" && stdout.rows > 0
      ? stdout.rows
      : Number.isFinite(envRows) && envRows > 0
        ? envRows
        : 0
  const termLabel =
    effCols > 0 && effRows > 0
      ? `${effCols} × ${effRows} ${c.dim("(cols × rows)")}`
      : c.dim("unknown")
  printStartupRow("term", termLabel)
}
