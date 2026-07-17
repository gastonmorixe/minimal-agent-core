/**
 * `--list-models`: merged live + registered model catalog, grouped by
 * provider.
 *
 * Provider-NEUTRAL by construction (OCP): live rows come from each
 * registered `ProviderPlugin.listLiveModels` hook; static rows come from
 * the canonical model registry. Adding a provider plugin extends this
 * listing with zero edits here. Live rows win on id collision (they carry
 * real `created_at` dates); a failed/missing live fetch degrades to the
 * registry so the command never hides the catalog on network trouble.
 *
 * @module commands/list-models
 */

import { tryResolveProviderAuth } from "../../auth/auth-strategies.ts"
import type { Capabilities, ServerToolId } from "../../llm/capabilities.ts"
import { listRegisteredModels, type ModelEntry } from "../../llm/model-registry.ts"
import type { ProviderAuth } from "../../llm/provider.ts"
import { listProviderPlugins } from "../../llm/provider-plugin.ts"
import { displayWidth, wordWrap } from "../../terminal/term-width.ts"
import { writeCommandRows } from "../ui/command-output.ts"
import { c } from "../ui/style/ansi.ts"

interface ModelRow {
  id: string
  displayName?: string
  providerId: string
  surface?: string
  date?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: Capabilities
}

interface CommandOutputWithColumns {
  write(s: string): unknown
  columns?: number
}

interface ListModelsDeps {
  output?: CommandOutputWithColumns
  error?: { write(s: string): unknown }
  columns?: number
}

interface ModelTableLayout {
  idW: number
  ctxW: number
  outW: number
  capsW: number
}

const SERVER_TOOL_LABELS: Record<ServerToolId, string> = {
  web_search: "web",
  code_interpreter: "code",
  computer_use: "comp",
  file_search: "file",
  advisor: "adv",
}

function applyRegisteredEntry(row: ModelRow, entry: ModelEntry): void {
  row.displayName ??= entry.displayName
  row.surface ??= entry.surfaceId
  row.date ??= entry.knowledgeCutoff
  row.contextWindow = entry.capabilities.contextWindow
  row.maxOutputTokens = entry.capabilities.maxOutputTokens
  row.capabilities = entry.capabilities
}

function resolveTerminalColumns(deps: ListModelsDeps): number {
  if (deps.columns && deps.columns > 0) return Math.floor(deps.columns)
  const outCols = deps.output?.columns
  if (outCols && outCols > 0) return Math.floor(outCols)
  // COLUMNS is injected by the host for child commands and lets non-TTY
  // callers retain an explicit width instead of inheriting the parent TTY.
  const envCols = Number.parseInt(process.env.COLUMNS ?? "", 10)
  if (Number.isFinite(envCols) && envCols > 0) return envCols
  if (process.stdout.columns && process.stdout.columns > 0)
    return Math.floor(process.stdout.columns)
  return 100
}

function formatTokenLimit(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return ""
  if (n >= 1_000_000) return `${trimDecimal(n / 1_000_000, 2)}M`
  if (n >= 1_000) return `${trimDecimal(n / 1_000, n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

function trimDecimal(n: number, places: number): string {
  return n
    .toFixed(places)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1")
}

function formatCapabilities(caps: Capabilities | undefined): string {
  if (!caps) return ""
  const parts: string[] = []

  if (caps.effort.levels.length > 0) {
    // Exact model-declared API vocabulary. Never normalize these names.
    parts.push(`eff:${caps.effort.levels.join("/")}`)
  }

  if (caps.thinking.visible) parts.push("think:vis")
  else if (caps.thinking.extended) parts.push("think:ext")
  else if (caps.thinking.adaptive) parts.push("think")

  const modalities = [
    caps.modalities.image ? "img" : "",
    caps.modalities.audio ? "aud" : "",
    caps.modalities.pdf ? "pdf" : "",
    caps.modalities.video ? "vid" : "",
  ].filter(Boolean)
  if (modalities.length > 0) parts.push(`in:${modalities.join(",")}`)

  if (caps.tools.userDefined) parts.push(caps.tools.strictSchema ? "tools:strict" : "tools")
  if (caps.serverTools.length > 0) {
    parts.push(`host:${caps.serverTools.map((tool) => SERVER_TOOL_LABELS[tool] ?? tool).join(",")}`)
  }
  if (caps.structuredOutputs) parts.push("json")
  if (caps.caching.automatic || caps.caching.explicit) {
    const cache = [caps.caching.automatic ? "auto" : "", caps.caching.explicit ? "explicit" : ""]
      .filter(Boolean)
      .join("+")
    parts.push(`cache:${cache}`)
  }
  if (caps.serverSideHistory) parts.push("hist")
  if (caps.speedFast) parts.push("fast-tier")

  return parts.length > 0 ? parts.join(" · ") : "text"
}

function chooseLayout(rows: ModelRow[], termColumns: number): ModelTableLayout {
  // Four cells of section-row indentation, plus ten cells of slack for ANSI
  // re-anchoring and terminal exact-fill quirks. Rows wrap before the edge.
  const available = Math.max(44, termColumns - 14)
  const maxIdW = Math.max(0, ...rows.map((r) => displayWidth(r.id)))
  const idW = Math.min(Math.max(16, maxIdW), available >= 80 ? 22 : 18)
  const ctxW = 9
  const outW = 9
  const capsW = Math.max(12, available - idW - ctxW - outW - 3)
  return { idW, ctxW, outW, capsW }
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`
}

function splitLongToken(token: string, width: number): string[] {
  if (width <= 0 || displayWidth(token) <= width) return [token]
  const out: string[] = []
  let current = ""
  for (const char of token) {
    if (displayWidth(current + char) > width && current.length > 0) {
      out.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current) out.push(current)
  return out
}

function wrapCapabilities(value: string, width: number): string[] {
  if (!value) return [""]
  const words = value.split(" ")
  const wrapped: string[] = []
  for (const word of words) {
    for (const line of wordWrap(word, width)) {
      if (displayWidth(line) <= width) wrapped.push(line)
      else wrapped.push(...splitLongToken(line, width))
    }
  }
  // `wordWrap` is intentionally called per semantic token so separators are
  // retained and the labels remain easy to scan. Pack the resulting chunks.
  const packed: string[] = []
  for (const token of wrapped) {
    const last = packed.at(-1)
    if (last !== undefined && displayWidth(`${last} ${token}`) <= width)
      packed[packed.length - 1] = `${last} ${token}`
    else packed.push(token)
  }
  return packed
}

function formatModelRow(row: ModelRow, layout: ModelTableLayout): string[] {
  // Model IDs are inputs users copy into configuration. Preserve an unusually
  // long id by giving it leading rows rather than clipping it.
  const idLines = splitLongToken(row.id, layout.idW)
  const id = idLines.pop() ?? ""
  const prefix = [
    pad(id, layout.idW),
    pad(row.contextWindow ? `ctx ${formatTokenLimit(row.contextWindow)}` : "", layout.ctxW),
    pad(row.maxOutputTokens ? `out ${formatTokenLimit(row.maxOutputTokens)}` : "", layout.outW),
  ].join(" ")
  const continuation = " ".repeat(displayWidth(prefix) + 1)
  const capabilities = wrapCapabilities(formatCapabilities(row.capabilities), layout.capsW)
  const metadata = [
    row.displayName ? `name:${row.displayName}` : "",
    row.surface ? `surface:${row.surface}` : "",
    row.date ? `cutoff:${row.date}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const metadataLines = wrapCapabilities(metadata, layout.capsW)

  const lines = idLines.map((line) => `    ${c.cyan(line)}`)
  lines.push(
    ...capabilities.map((capability, index) => {
      if (index === 0)
        return `    ${c.cyan(prefix.slice(0, layout.idW))}${prefix.slice(layout.idW)} ${capability}`.trimEnd()
      return `    ${continuation}${capability}`.trimEnd()
    }),
  )
  for (const line of metadataLines) {
    if (line) lines.push(`    ${continuation}${c.dim(line)}`)
  }
  return lines
}

/**
 * Composite map key for one model under one provider.
 *
 * Live catalogs often reuse bare slugs across gateways (`kimi-k2.6` on both
 * Ollama Cloud and OpenCode Go). Merging on bare `id` alone lets one provider's
 * live row steal another provider's static registration — the OpenCode catalog
 * collapsed to the handful of slugs Ollama did not also advertise. Always key
 * by `providerId\0id` so providers stay independent.
 */
function modelRowKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`
}

/**
 * Implements `minimal-agent list-models`: merges live model catalogs from
 * every provider plugin (queried in parallel, fault-isolated so one outage
 * cannot hide another provider's rows) with the static registry fallback,
 * then prints a deduplicated table, optionally filtered to one provider.
 *
 * Dedup is **per provider**: the same model id may appear under multiple
 * providers (e.g. `deepseek-v4-flash` on Ollama and OpenCode). Live wins over
 * static only within the same provider.
 */
export async function runListModelsCommand(
  providerFilter?: string,
  deps: ListModelsDeps = {},
): Promise<void> {
  const byKey = new Map<string, ModelRow>()

  const plugins = listProviderPlugins().filter((p) => typeof p.listLiveModels === "function")
  const results = await Promise.allSettled(
    plugins.map(async (p) => {
      const providerAuth: ProviderAuth | null =
        tryResolveProviderAuth(p.id, "") ??
        (p.publicModelList ? { kind: "custom", headers: {} } : null)
      if (!providerAuth)
        return { plugin: p, rows: [] as Awaited<ReturnType<NonNullable<typeof p.listLiveModels>>> }
      return { plugin: p, rows: await p.listLiveModels?.(providerAuth) }
    }),
  )
  for (const r of results) {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      ;(deps.error ?? process.stderr).write(`  ${c.dim(`(live model list unavailable: ${msg})`)}\n`)
      continue
    }
    for (const m of r.value.rows ?? []) {
      const providerId = r.value.plugin.id
      byKey.set(modelRowKey(providerId, m.id), {
        id: m.id,
        displayName: m.displayName,
        providerId,
        date: m.createdAt,
      })
    }
  }

  for (const entry of listRegisteredModels()) {
    const key = modelRowKey(entry.providerId, entry.id)
    const existing = byKey.get(key)
    if (existing) {
      // Same provider only: enrich the live row with static caps/surface/name.
      // Never reassign providerId — that would reintroduce cross-provider theft.
      applyRegisteredEntry(existing, entry)
      continue
    }
    const row: ModelRow = {
      id: entry.id,
      displayName: entry.displayName,
      providerId: entry.providerId,
    }
    applyRegisteredEntry(row, entry)
    byKey.set(key, row)
  }

  const byProvider = new Map<string, ModelRow[]>()
  for (const row of byKey.values()) {
    const list = byProvider.get(row.providerId)
    if (list) list.push(row)
    else byProvider.set(row.providerId, [row])
  }

  const providerIds = providerFilter ? [providerFilter] : [...byProvider.keys()].sort()
  const shownRows = providerIds.flatMap((p) => byProvider.get(p) ?? [])
  if (shownRows.length === 0) {
    const empty = providerFilter
      ? `no models registered for provider "${providerFilter}"`
      : "no models registered"
    writeCommandRows(["", `  ${c.dim(empty)}`, `  ${c.dim("0 models available")}`], deps.output)
    return
  }

  const layout = chooseLayout(shownRows, resolveTerminalColumns(deps))
  const lines: string[] = [""]
  let shown = 0
  for (const provider of providerIds) {
    const rows = byProvider.get(provider)
    if (!rows || rows.length === 0) continue
    lines.push(`  ${c.bold(provider)}`)
    for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(...formatModelRow(row, layout))
      shown++
    }
    lines.push("")
  }
  if (lines.at(-1) === "") lines.pop()
  lines.push(`  ${c.dim(`${shown} models available`)}`)
  writeCommandRows(lines, deps.output)
}
