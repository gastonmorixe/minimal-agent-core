/**
 * `--list-models` / `ma models` / `ma provider <id> models`:
 * **static** registered model catalog only, grouped by provider.
 *
 * Never reaches the network. Live server catalogs belong on a separate
 * `models-live` command (see Task 3). This command is the offline source of
 * truth for what the process actually registered at bootstrap — capabilities,
 * pricing, surfaces, etc. — not what a provider advertises right now.
 *
 * Provider-NEUTRAL by construction (OCP): rows come solely from the canonical
 * model registry populated by `ProviderPlugin.register`. Adding a provider
 * plugin extends this listing with zero edits here.
 *
 * @module commands/list-models
 */

import { displayWidth, wordWrap } from "@minimal-agent/core/plugin-api/utils/term-width"

import type { PrintFormat } from "../../cli/print-format.ts"
import type { Capabilities, ServerToolId } from "../../llm/capabilities.ts"
import { canonicalProviderId } from "../../llm/provider-plugin.ts"
import { writeCommandRows } from "../ui/command-output.ts"
import { c } from "../ui/style/ansi.ts"

import {
  collectRegisteredModelRows,
  groupModelRowsByProvider,
  type ModelCatalogRow,
} from "./model-catalog-data.ts"

type ModelRow = ModelCatalogRow

interface CommandOutputWithColumns {
  write(s: string): unknown
  columns?: number
}

interface ListModelsDeps {
  output?: CommandOutputWithColumns
  error?: { write(s: string): unknown }
  columns?: number
  /** Inspection print format (`text` default). See `--print-format`. */
  printFormat?: PrintFormat
}

interface ModelTableLayout {
  idW: number
  ctxW: number
  outW: number
  capsW: number
  /** When false, caps/metadata start on the next line at full content width. */
  capsOnPrimary: boolean
}

const SERVER_TOOL_LABELS: Record<ServerToolId, string> = {
  web_search: "web",
  code_interpreter: "code",
  computer_use: "comp",
  file_search: "file",
  advisor: "adv",
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
  // re-anchoring and terminal exact-fill quirks. Caps wrap before the edge;
  // model ids never wrap mid-token — they are copy/paste inputs.
  const available = Math.max(44, termColumns - 14)
  const maxIdW = Math.max(0, ...rows.map((r) => displayWidth(r.id)))
  // Always size the id column to the longest model id (floor 16). An artificial
  // 18/22 cap used to hard-wrap names like `cursor-claude-4.5-haiku` mid-word.
  const idW = Math.max(16, maxIdW)
  const ctxW = 9
  const outW = 9
  const residual = available - idW - ctxW - outW - 3
  // If the id column leaves a usable residual, keep the classic four-column
  // row. Otherwise stack caps under the primary line at full content width so
  // labels are not shredded into 12-cell fragments.
  const capsOnPrimary = residual >= 20
  const capsW = capsOnPrimary ? residual : available
  return { idW, ctxW, outW, capsW, capsOnPrimary }
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
  // Model IDs are inputs users copy into configuration. Never hard-wrap or
  // clip them mid-token: layout.idW is sized to the longest id, so the full
  // name stays on the primary row as a contiguous string.
  const idCell = pad(row.id, layout.idW)
  const prefix = [
    idCell,
    pad(row.contextWindow ? `ctx ${formatTokenLimit(row.contextWindow)}` : "", layout.ctxW),
    pad(row.maxOutputTokens ? `out ${formatTokenLimit(row.maxOutputTokens)}` : "", layout.outW),
  ].join(" ")
  // Same-line caps hang under the residual column; stacked caps hang under a
  // fixed indent so the wrap width can use the full content area.
  const continuation = layout.capsOnPrimary ? " ".repeat(displayWidth(prefix) + 1) : "  "
  const capabilities = wrapCapabilities(formatCapabilities(row.capabilities), layout.capsW)
  const metadata = [
    row.displayName ? `name:${row.displayName}` : "",
    row.surface ? `surface:${row.surface}` : "",
    row.date ? `cutoff:${row.date}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const metadataLines = wrapCapabilities(metadata, layout.capsW)

  const lines: string[] = []
  if (layout.capsOnPrimary) {
    lines.push(
      ...capabilities.map((capability, index) => {
        if (index === 0)
          return `    ${c.cyan(idCell)}${prefix.slice(idCell.length)} ${capability}`.trimEnd()
        return `    ${continuation}${capability}`.trimEnd()
      }),
    )
  } else {
    lines.push(`    ${c.cyan(idCell)}${prefix.slice(idCell.length)}`.trimEnd())
    for (const capability of capabilities) {
      if (capability) lines.push(`    ${continuation}${capability}`.trimEnd())
    }
  }
  for (const line of metadataLines) {
    if (line) lines.push(`    ${continuation}${c.dim(line)}`)
  }
  return lines
}

/**
 * Implements `minimal-agent list-models`: prints the **static** registered
 * model catalog (no network, no auth, no `listLiveModels`). Optionally
 * filtered to one provider.
 *
 * Dedup is **per provider**: the same model id may appear under multiple
 * providers (e.g. `deepseek-v4-flash` on Ollama and OpenCode).
 *
 * Kept async for call-site stability (`runStartupSubcommand` / tests).
 */
export async function runListModelsCommand(
  rawProviderFilter?: string,
  deps: ListModelsDeps = {},
): Promise<void> {
  const providerFilter = rawProviderFilter ? canonicalProviderId(rawProviderFilter) : undefined
  const rows = collectRegisteredModelRows(providerFilter)
  const format = deps.printFormat ?? "text"

  if (format === "json") {
    const payload = {
      kind: "models",
      source: "registry",
      providerFilter: providerFilter ?? null,
      models: rows.map((r) => ({
        id: r.id,
        displayName: r.displayName ?? null,
        providerId: r.providerId,
        surface: r.surface ?? null,
        knowledgeCutoff: r.date ?? null,
        contextWindow: r.contextWindow ?? null,
        maxOutputTokens: r.maxOutputTokens ?? null,
        capabilities: r.capabilities ?? null,
      })),
      count: rows.length,
    }
    writeCommandRows([JSON.stringify(payload, null, 2)], deps.output)
    return
  }

  if (format === "md" || format === "xml") {
    // Skeleton: structured formats beyond json land in a follow-up.
    writeCommandRows(
      [
        "",
        `  ${c.dim(`print-format "${format}" not implemented yet for models; use text or json`)}`,
      ],
      deps.output,
    )
    return
  }

  const byProvider = groupModelRowsByProvider(rows)
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
    const providerRows = byProvider.get(provider)
    if (!providerRows || providerRows.length === 0) continue
    lines.push(`  ${c.bold(provider)}`)
    for (const row of providerRows.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(...formatModelRow(row, layout))
      shown++
    }
    lines.push("")
  }
  if (lines.at(-1) === "") lines.pop()
  lines.push(`  ${c.dim(`${shown} models available`)}`)
  writeCommandRows(lines, deps.output)
}
