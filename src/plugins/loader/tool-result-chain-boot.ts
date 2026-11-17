/**
 * Boot glue for the tool-result transform chain and the sideband registry
 * (spec v6.1 D1 items 1 to 3).
 *
 * - {@link loadPluginTransforms}: import the `toolResultTransforms` module of
 *   one plugin and return its chain entries (item 1). It also applies the
 *   stage time limit rule (`timeoutMs`, D1 item 8).
 * - {@link finalizeChain}: run `validateChain` once per load. A violation
 *   disables the extra stages and emits ONE diagnostic (item 3).
 * - {@link bootSidebandRegistry}: one registry per load, with the manifest
 *   `sideband` kinds and the `sidebandCodec` factory, then frozen (item 2).
 *
 * Diagnostics carry identifiers only and an empty message. Nothing here
 * throws: boot always goes on.
 *
 * @module plugins/loader/tool-result-chain-boot
 */

import type { ToolResultTransformDecl } from "../../../plugin-api/src/types/tool-result-chain.ts"
import {
  orderStages,
  TOOL_RESULT_PHASES,
  type ToolResultChainEntry,
  validateChain,
} from "../../loops/tool-result-chain.ts"
import { createSidebandRegistry } from "../../sideband/registry.ts"
import type {
  ReadonlySidebandRegistry,
  SidebandCodec,
  SidebandCodecFactory,
  SidebandKind,
} from "../../sideband/types.ts"
import { pluginPackageFor } from "../source.ts"
import type { LoadedPlugin } from "../types.ts"

import type { DiagnosticsRelay } from "./diagnostics-relay.ts"
import type { DiscoveryResult } from "./discovery.ts"

/**
 * The frozen registry view that the loader exposes. It has no `register`,
 * `setCodec` or `freeze`. `codec()` throws `SidebandCodecMissingError` when no
 * plugin supplies a codec.
 */
export type LoadedSidebandRegistry = ReadonlySidebandRegistry & { codec(): SidebandCodec }

/**
 * A decl with the stage time limit.
 *
 * TODO(helen): use `ToolResultTransformDecl.timeoutMs` when Gabriel's W1
 * commit (tool-result-chain.ts, D1 item 8 stage time limit) adds the field,
 * then remove this local type.
 */
export type TimedToolResultTransformDecl = ToolResultTransformDecl & { timeoutMs?: number }

/** Default and maximum stage time limit, in ms (spec v6.1 D1 item 8). */
export const STAGE_TIMEOUT_MAX_MS = 2000
/** Minimum stage time limit, in ms. */
export const STAGE_TIMEOUT_MIN_MS = 1

/** The parsed `toolResultTransforms` manifest value. */
export interface ToolResultTransformsRaw {
  /** Entry id. */
  id: string
  /** Module path. */
  entry: string
  /** The raw `timeoutMs` value. `undefined` when the key is absent. */
  timeoutMs?: unknown
}

/**
 * Parse a raw `toolResultTransforms` value: `{id, entry}` of non-empty
 * strings, else `undefined`. The raw `timeoutMs` is kept as is.
 */
export function parseToolResultTransformsRaw(raw: unknown): ToolResultTransformsRaw | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.id !== "string" || o.id.length === 0) return undefined
  if (typeof o.entry !== "string" || o.entry.length === 0) return undefined
  return {
    id: o.id,
    entry: o.entry,
    ...("timeoutMs" in o && o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  }
}

/** The result of {@link resolveStageTimeout}. */
export interface StageTimeout {
  /** The limit to apply, in ms. */
  applied: number
  /** True when the requested value was changed (a diagnostic is due). */
  clamped: boolean
}

/**
 * Apply the stage time limit rule. Absent: 2000, no change. Not a finite
 * number: 2000, changed. Else floor, then clamp to 1..2000. A value that is
 * in range after the floor is not changed.
 */
export function resolveStageTimeout(requested: unknown): StageTimeout {
  if (requested === undefined) return { applied: STAGE_TIMEOUT_MAX_MS, clamped: false }
  if (typeof requested !== "number" || !Number.isFinite(requested))
    return { applied: STAGE_TIMEOUT_MAX_MS, clamped: true }
  const floored = Math.floor(requested)
  if (floored < STAGE_TIMEOUT_MIN_MS) return { applied: STAGE_TIMEOUT_MIN_MS, clamped: true }
  if (floored > STAGE_TIMEOUT_MAX_MS) return { applied: STAGE_TIMEOUT_MAX_MS, clamped: true }
  return { applied: floored, clamped: false }
}

/** The `requested` diagnostic value: the number when finite, else its text. */
function requestedData(v: unknown): string | number {
  return typeof v === "number" && Number.isFinite(v) ? v : String(v)
}

/** True when `v` is a valid decl: known phase, finite number order, function transform. */
function isDecl(v: unknown): v is ToolResultTransformDecl {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.phase === "string" &&
    (TOOL_RESULT_PHASES as readonly string[]).includes(o.phase) &&
    typeof o.order === "number" &&
    Number.isFinite(o.order) &&
    typeof o.transform === "function"
  )
}

/**
 * Import the `toolResultTransforms` entry of one plugin and return its
 * entries. The default export is `ToolResultTransformDecl[]` or a function
 * that returns it (sync or async). A missing module, a throw or a non-array
 * result gives one `tool-result-chain.load-failed` diagnostic and `[]`. A bad
 * element is skipped with one `tool-result-chain.decl-invalid` diagnostic.
 * Each kept decl gets `timeoutMs` (see {@link resolveStageTimeout}). A
 * clamped value gives one `tool-result-chain.timeout-clamped` diagnostic per
 * stage. Never throws.
 */
export async function loadPluginTransforms(
  raw: unknown,
  packageDir: string,
  pluginId: string,
  relay: DiagnosticsRelay,
): Promise<ToolResultChainEntry[]> {
  if (raw === undefined || raw === null) return []
  const parsed = parseToolResultTransformsRaw(raw)
  if (parsed === undefined) {
    relay.warn("tool-result-chain.load-failed", "", { plugin: pluginId, reason: "bad-raw" })
    return []
  }
  let list: unknown
  try {
    const pkg = pluginPackageFor(packageDir)
    if (!pkg.hasFile(parsed.entry)) {
      relay.warn("tool-result-chain.load-failed", "", {
        plugin: pluginId,
        reason: "module-missing",
      })
      return []
    }
    const mod = (await pkg.importModule(parsed.entry)) as { default?: unknown }
    list = typeof mod.default === "function" ? await (mod.default as () => unknown)() : mod.default
  } catch {
    relay.warn("tool-result-chain.load-failed", "", { plugin: pluginId, reason: "import-threw" })
    return []
  }
  if (!Array.isArray(list)) {
    relay.warn("tool-result-chain.load-failed", "", { plugin: pluginId, reason: "not-array" })
    return []
  }
  const timeout = resolveStageTimeout(parsed.timeoutMs)
  const out: ToolResultChainEntry[] = []
  list.forEach((d: unknown, index) => {
    if (!isDecl(d)) {
      relay.warn("tool-result-chain.decl-invalid", "", { plugin: pluginId, index })
      return
    }
    const decl: TimedToolResultTransformDecl = Object.freeze({
      ...d,
      transform: d.transform.bind(d),
      timeoutMs: timeout.applied,
    })
    if (timeout.clamped) {
      relay.warn("tool-result-chain.timeout-clamped", "", {
        pluginId,
        phase: d.phase,
        requested: requestedData(parsed.timeoutMs),
        applied: timeout.applied,
      })
    }
    out.push({ pluginId, decl })
  })
  return out
}

/**
 * Validate the collected entries (`validateChain`). On a violation, keep the
 * first stage of the clamp and the stamp phase in run order (`orderStages`),
 * drop the extra stages and the entries with an unknown phase, and emit ONE
 * `tool-result-chain.invalid` diagnostic. Never throws. Boot goes on.
 */
export function finalizeChain(
  entries: readonly ToolResultChainEntry[],
  relay: DiagnosticsRelay,
): readonly ToolResultChainEntry[] {
  const v = validateChain(entries)
  if (v.ok) return Object.freeze([...entries])
  const kept: ToolResultChainEntry[] = []
  const dropped: string[] = []
  const seenSingle = new Set<string>()
  for (const e of orderStages(entries)) {
    if (!TOOL_RESULT_PHASES.includes(e.decl.phase)) {
      dropped.push(e.pluginId)
      continue
    }
    if (e.decl.phase === "clamp" || e.decl.phase === "stamp") {
      if (seenSingle.has(e.decl.phase)) {
        dropped.push(e.pluginId)
        continue
      }
      seenSingle.add(e.decl.phase)
    }
    kept.push(e)
  }
  relay.warn("tool-result-chain.invalid", "", {
    violations: v.violations.map((x) => x.kind).join(","),
    disabled: dropped.length,
    plugins: dropped.join(","),
  })
  return Object.freeze(kept)
}

/** The error name of `e`, for a diagnostic. */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown"
}

/**
 * Build the sideband registry of one load: set the codec from
 * `sidebandCodec`, register the `sideband` kinds of each plugin, then freeze
 * (SB-REG-8). A rejected kind gives one `sideband.kind-rejected` diagnostic.
 * A failed codec gives one `sideband.codec-load-failed` diagnostic. Never
 * throws. The codec is not built here: `codec()` builds it on the first call.
 */
export async function bootSidebandRegistry(
  plugins: readonly LoadedPlugin[],
  relay: DiagnosticsRelay,
): Promise<LoadedSidebandRegistry> {
  const registry = createSidebandRegistry()
  for (const p of plugins) {
    const plugin = p.manifest.id
    const codecDecl = p.manifest.sidebandCodec
    if (codecDecl !== undefined) {
      try {
        const pkg = pluginPackageFor(p.packageDir)
        if (!pkg.hasFile(codecDecl.entry)) {
          relay.warn("sideband.codec-load-failed", "", { plugin, reason: "module-missing" })
        } else {
          const mod = (await pkg.importModule(codecDecl.entry)) as { default?: unknown }
          if (typeof mod.default !== "function") {
            relay.warn("sideband.codec-load-failed", "", { plugin, reason: "not-function" })
          } else {
            registry.setCodec(mod.default as SidebandCodecFactory, plugin)
          }
        }
      } catch (e) {
        const duplicate = errorName(e) === "SidebandCodecDuplicateError"
        relay.warn("sideband.codec-load-failed", "", {
          plugin,
          reason: duplicate ? "duplicate" : "import-threw",
        })
      }
    }
    for (const k of p.manifest.sideband ?? []) {
      try {
        // `ManifestSidebandKind` is `SidebandKind` without `owner`. The
        // registry sets `owner` (registry.ts:103).
        registry.register(k as SidebandKind, plugin)
      } catch (e) {
        relay.warn("sideband.kind-rejected", "", { plugin, kind: k.kind, error: errorName(e) })
      }
    }
  }
  registry.freeze()
  return narrow(registry)
}

/** The read-only view of a registry: no `register`, `setCodec` or `freeze`. */
function narrow(r: LoadedSidebandRegistry): LoadedSidebandRegistry {
  return Object.freeze({
    kind: (name: string) => r.kind(name),
    kinds: () => r.kinds(),
    codec: () => r.codec(),
  })
}

/** An empty frozen registry, for a loader that did not run `load()`. */
export function emptySidebandRegistry(): LoadedSidebandRegistry {
  const r = createSidebandRegistry()
  r.freeze()
  return narrow(r)
}

/** The chain and the registry of one load (spec v6.1 D1 items 1 to 3). */
export interface ChainBoot {
  /** The validated, frozen chain. */
  readonly chain: readonly ToolResultChainEntry[]
  /** The frozen sideband registry. */
  readonly sideband: LoadedSidebandRegistry
}

/** The state of a loader that did not run `load()`: no stages, no kinds. */
export function emptyChainBoot(): ChainBoot {
  return { chain: Object.freeze([]), sideband: emptySidebandRegistry() }
}

/**
 * Boot the chain and the registry of one load. `plugins` are the accepted
 * plugins in boot order. `discovered.toolResultTransformsRaw` holds the raw
 * `toolResultTransforms` values keyed by package dir. Collect the entries of each plugin (item 1), validate
 * them once (item 3), then build the registry (item 2). Never throws.
 */
export async function bootToolResultChain(
  plugins: readonly LoadedPlugin[],
  discovered: Pick<DiscoveryResult, "toolResultTransformsRaw">,
  relay: DiagnosticsRelay,
): Promise<ChainBoot> {
  const raw = discovered.toolResultTransformsRaw
  const entries: ToolResultChainEntry[] = []
  for (const p of plugins) {
    const dir = p.packageDir
    entries.push(...(await loadPluginTransforms(raw.get(dir), dir, p.manifest.id, relay)))
  }
  const chain = finalizeChain(entries, relay)
  return { chain, sideband: await bootSidebandRegistry(plugins, relay) }
}
