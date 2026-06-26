/**
 * `tool.didInvoke` chain handler — the diagnostics plugin's single attach point.
 *
 * After an Edit/Write succeeds, this reads the just-written file and runs the
 * detected diagnostic tools (type/format/lint) for it, then pushes structured
 * `findings` (the agent renders them) and compact `notes` (the agent wraps them
 * in `<ma::agent::diagnostics>`) onto the chain payload. The agent owns all
 * rendering; this handler only supplies data.
 *
 * DECOUPLING: imports nothing from the agent's `src/`. The payload is a
 * structural contract (`findings`/`notes` accumulators). All heavy state (the
 * persistent tsgo LSP) lives in a per-root {@link DiagnosticsService} memoized
 * across calls, disposed when the process exits.
 *
 * Defensive throughout: any failure returns the payload unchanged (the HookBus
 * also absorbs throws), so diagnostics can never break a tool result.
 *
 * @module plugins/diagnostics/handlers/on_tool_did_invoke
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { resolveAgentHome } from "@minimal-agent/plugin-api/utils/agent-paths"

import { loadConfig } from "../lib/config.ts"
import { findProjectRoot } from "../lib/detect.ts"
import { DiagnosticsService, type ProviderFactories } from "../lib/service.ts"
import { BiomeProvider } from "../providers/biome-provider.ts"
import { OxlintProvider } from "../providers/oxlint-provider.ts"
import { SourceKitLspProvider } from "../providers/sourcekit-lsp-provider.ts"
import { TscDirectProvider } from "../providers/tsc-direct-provider.ts"
import { TscSpawnProvider } from "../providers/tsc-provider.ts"
import { TsgoLspProvider } from "../providers/tsgo-provider.ts"

/** Minimal payload view (structural mirror of the agent's ToolDidInvokePayload). */
interface ToolDidInvokePayload {
  tool: string
  input: Record<string, unknown>
  cwd: string
  ok: boolean
  filePath?: string
  findings: unknown[]
  notes: string[]
}

interface ChainCtx {
  cwd: string
  env: Record<string, string>
  log?: (msg: string) => void
}

/** Real provider factories (spawn / LSP). Swapped for fakes in tests. */
const REAL_FACTORIES: ProviderFactories = {
  makeTsgo: (bin, root) => new TsgoLspProvider(bin, root),
  makeTsc: (bin, root) => new TscSpawnProvider(bin, root),
  makeTscDirect: (bin, root) => new TscDirectProvider(bin, root),
  makeBiome: (bin, root) => new BiomeProvider(bin, root),
  makeOxlint: (bin, root) => new OxlintProvider(bin, root),
  makeSourceKit: (bin, root) => new SourceKitLspProvider(bin, root),
}

/** Per-root service cache so the persistent tsgo LSP is reused across edits. */
const services = new Map<string, DiagnosticsService>()

/**
 * Collect active persistent LSP provider ids across all cached roots.
 * Used by the live-area slot to render the LSP indicator in the TUI.
 */
export function getActivePersistentProviders(): string[] {
  const seen = new Set<string>()
  for (const svc of services.values()) {
    for (const id of svc.getActivePersistentProviders()) seen.add(id)
  }
  return [...seen].sort()
}
let exitHookInstalled = false

/** Tolerant JSONC-ish parse (strip // and /* *​/ comments) without a dependency. */
function parseJsoncish(raw: string): unknown {
  const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
  try {
    return JSON.parse(noComments)
  } catch {
    return {}
  }
}

function configPath(): string {
  const override = process.env.MINIMAL_AGENT_CONFIG_PATH
  if (override) return override
  return join(resolveAgentHome(), "config.jsonc")
}

function serviceFor(root: string): DiagnosticsService {
  let svc = services.get(root)
  if (!svc) {
    const cfg = loadConfig(configPath(), parseJsoncish)
    svc = new DiagnosticsService(root, cfg, REAL_FACTORIES)
    services.set(root, svc)
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    const dispose = () => {
      for (const s of services.values()) s.dispose()
      services.clear()
    }
    // Bare signal handlers would DISABLE default termination when the host
    // app has none of its own (Ctrl-C swallowed by a cleanup hook). So:
    // dispose, then RE-RAISE. `once` has already removed this handler by
    // then, so the re-raised signal falls through to the host's handlers
    // (if any) or the default disposition (terminate). Host handlers are
    // never touched.
    process.once("exit", dispose)
    const onSignal = (sig: NodeJS.Signals) => () => {
      dispose()
      process.kill(process.pid, sig)
    }
    process.once("SIGINT", onSignal("SIGINT"))
    process.once("SIGTERM", onSignal("SIGTERM"))
  }
  return svc
}

/** Tools whose results carry a file we should diagnose. */
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write"])

/**
 * Post-tool hook that lints a file right after a successful Edit/Write:
 * resolves the touched path, runs the diagnostics service on it, and appends
 * the findings to the tool result as model-facing notes. Best-effort
 * throughout; any internal failure leaves the payload unmodified rather than
 * breaking the tool call.
 */
export default async function onToolDidInvoke(
  payload: ToolDidInvokePayload,
  ctx: ChainCtx,
): Promise<{ payload: ToolDidInvokePayload } | void> {
  try {
    if (!payload || !payload.ok) return
    if (!FILE_MUTATING_TOOLS.has(payload.tool)) return
    const filePath =
      payload.filePath ??
      (typeof payload.input?.file_path === "string"
        ? (payload.input.file_path as string)
        : undefined)
    if (!filePath || !existsSync(filePath)) return

    const root = ctx.cwd || payload.cwd || process.cwd()

    // Auto-detect project root from the file's location so that
    // diagnostics work even when the agent's cwd is not the project
    // directory (e.g. editing a .swift file from a different workspace).
    const projectRoot = findProjectRoot(filePath)
    const effectiveRoot = projectRoot && projectRoot !== root ? projectRoot : root

    const svc = serviceFor(effectiveRoot)
    if (!svc.handles(filePath)) return

    // The Edit/Write already wrote the file: disk == proposed text.
    let text: string
    try {
      text = readFileSync(filePath, "utf8")
    } catch {
      return
    }

    const result = await svc.check(filePath, text)
    if (result.findings.length === 0 && result.notes.length === 0) return

    // Push onto the accumulators the agent reads back. The agent renders
    // `findings` into its own chrome and wraps `notes` in the annotation.
    for (const finding of result.findings) payload.findings.push(finding)
    for (const note of result.notes) payload.notes.push(note)
    return { payload }
  } catch (e) {
    ctx.log?.(`diagnostics handler error: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
}
