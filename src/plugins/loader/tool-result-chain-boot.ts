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
 * Diagnostics carry identifiers only and an empty message. Each per-plugin
 * diagnostic has the data key `pluginId` (see {@link PluginBootDiagnostics}),
 * the same key as the runner `stage-failed` diagnostic. Nothing here
 * throws: boot always goes on. An async module import (and the async
 * transforms factory) that does not settle in {@link BOOT_IMPORT_TIMEOUT_MS}
 * is abandoned (fail open, M1). A plugin-owned list or decl is read only
 * once, inside a try (a snapshot, F3), so a throwing getter or Proxy disables
 * that plugin only. The codec stays lazy and synchronous: a failed codec
 * factory acts as "no codec" after one diagnostic.
 *
 * @module plugins/loader/tool-result-chain-boot
 */

import type {
  ToolResultStage,
  ToolResultTransformDecl,
} from "../../../plugin-api/src/types/tool-result-chain.ts"
import { abortableSleep } from "../../../plugin-api/src/utils/retry.ts"
import {
  clampStageTimeout,
  orderStages,
  STAGE_TIMEOUT_MS,
  TOOL_RESULT_PHASES,
  type ToolResultChainEntry,
  validateChain,
} from "../../loops/tool-result-chain.ts"
import { createSidebandApi, type SidebandApiDiagnostics } from "../../sideband/api.ts"
import { SidebandCodecMissingError } from "../../sideband/errors.ts"
import { createSidebandRegistry } from "../../sideband/registry.ts"
import type {
  ReadonlySidebandRegistry,
  SidebandApi,
  SidebandCodec,
  SidebandCodecFactory,
  SidebandKind,
  SidebandRegistry,
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

/** Time limit for one async module import (and its async factory) at boot, in ms. */
export const BOOT_IMPORT_TIMEOUT_MS = 2000

/** The value of {@link raceImport} when the time limit ends first. */
const TIMED_OUT: unique symbol = Symbol("timed-out")

/**
 * Race an async boot import against a time limit of `ms` (M1). The limit is
 * `abortableSleep` (plugin-api retry.ts), not a raw timer: the core timer
 * ratchet does not allow a new `setTimeout` site. The sleep is aborted when
 * the race ends, so its timer is cleared. A rejection of `work` is passed on.
 */
async function raceImport<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const ac = new AbortController()
  const limit = abortableSleep(ms, ac.signal).then(
    (): typeof TIMED_OUT => TIMED_OUT,
    (): typeof TIMED_OUT => TIMED_OUT,
  )
  try {
    return await Promise.race([work, limit])
  } finally {
    ac.abort()
  }
}

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

/** Why a stage time limit was changed (`tool-result-chain.timeout-clamped`). */
export type StageTimeoutReason = "invalid" | "clamped"

/**
 * Why the `toolResultTransforms` of one plugin gave no entries
 * (`tool-result-chain.load-failed`). See {@link loadPluginTransforms}.
 */
export type LoaderChainFailReason =
  | "bad-raw"
  | "module-missing"
  | "import-threw"
  | "timeout"
  | "not-array"
  | "decl-threw"

/** Why the `sidebandCodec` module of one plugin gave no factory (`sideband.codec-load-failed`). */
export type SidebandCodecLoadFailReason =
  | "duplicate"
  | "module-missing"
  | "timeout"
  | "not-function"
  | "import-threw"

/** Why a codec factory gave no codec (`sideband.codec-failed`). */
export type SidebandCodecFailReason = "error" | "async"

/** Each reason of a sideband boot diagnostic (`codec-load-failed` and `codec-failed`). */
export type SidebandBootFailReason = SidebandCodecLoadFailReason | SidebandCodecFailReason

/**
 * The data of each per-plugin diagnostic of this file, keyed by diagnostic id.
 * {@link warnPlugin} adds `pluginId`. These types have no `pluginId` and no
 * `plugin` key (the excess property check rejects them in a literal), so the
 * plugin id key cannot drift. The runner `stage-failed` diagnostic uses
 * `pluginId` too.
 */
export interface PluginBootDiagnostics {
  "tool-result-chain.load-failed": { reason: LoaderChainFailReason }
  "tool-result-chain.decl-invalid": { index: number }
  "tool-result-chain.timeout-clamped": {
    phase: string
    requested: string | number
    applied: number
    reason: StageTimeoutReason
  }
  "sideband.codec-load-failed": { reason: SidebandCodecLoadFailReason }
  "sideband.codec-failed": { reason: SidebandCodecFailReason }
  "sideband.kind-rejected": { kind: string; error: string }
}

/**
 * The data of the chain-level `tool-result-chain.invalid` diagnostic. It
 * names no single plugin, so it has no `pluginId` key.
 */
export interface ChainInvalidDiagnostic {
  /** The violation kinds, comma-joined. */
  violations: string
  /** The number of dropped entries. */
  disabled: number
  /**
   * The plugin id of each dropped entry (one item per entry), sorted and
   * joined with `","`. A plugin id cannot hold a `","` (manifest `ID_RE`).
   * A string, because `StructuredData` holds scalar values only (RFC 5424).
   */
  pluginIds: string
}

/** Emit one per-plugin diagnostic: an empty message and `{pluginId, ...data}`. */
function warnPlugin<K extends keyof PluginBootDiagnostics>(
  relay: DiagnosticsRelay,
  id: K,
  pluginId: string,
  data: PluginBootDiagnostics[K],
): void {
  relay.warn(id, "", { pluginId, ...data })
}

/** The result of {@link resolveStageTimeout}. */
export interface StageTimeout {
  /** The limit to apply, in ms. */
  applied: number
  /** Set when a diagnostic is due: the value that was changed, and why. */
  change?: { requested: unknown; reason: StageTimeoutReason }
}

/** True when `v` is a finite number. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

/**
 * Apply the stage time limit rule (F5) to one decl. A value is present when
 * it is not `undefined`. The base is the decl value if present, else the
 * manifest value if present, else 2000. A present value that is not a finite
 * number is invalid: the base is then the manifest value when it is present
 * and valid, else 2000, and the change reason is `invalid`. A valid decl value
 * is never replaced by the manifest value. Then floor, and clamp to 1..2000:
 * a value out of range gives the reason `clamped`. A missing value gives no
 * change. At most one change per decl.
 */
export function resolveStageTimeout(declValue: unknown, manifestValue?: unknown): StageTimeout {
  const fallback = (requested: unknown): StageTimeout => ({
    applied: isFiniteNumber(manifestValue) ? clampStageTimeout(manifestValue) : STAGE_TIMEOUT_MS,
    change: { requested, reason: "invalid" },
  })
  let base: number
  if (declValue !== undefined) {
    if (!isFiniteNumber(declValue)) return fallback(declValue)
    base = declValue
  } else if (manifestValue !== undefined) {
    if (!isFiniteNumber(manifestValue)) {
      return {
        applied: STAGE_TIMEOUT_MS,
        change: { requested: manifestValue, reason: "invalid" },
      }
    }
    base = manifestValue
  } else {
    return { applied: STAGE_TIMEOUT_MS }
  }
  // `base` is a finite number here: the shared clamp only floors and clamps.
  const applied = clampStageTimeout(base)
  return applied === Math.floor(base)
    ? { applied }
    : { applied, change: { requested: base, reason: "clamped" } }
}

/** The `requested` diagnostic value: the number when finite, else its text. */
function requestedData(v: unknown): string | number {
  return isFiniteNumber(v) ? v : String(v)
}

/** The decl fields, each read once from the plugin object (F3). */
interface DeclSnapshot {
  phase: unknown
  order: unknown
  transform: unknown
  timeoutMs: unknown
  /** The plugin decl object, the `this` of `transform`. */
  self: unknown
}

/**
 * Copy the list of one plugin and the decl fields of each element, each read
 * once. `undefined` for an element that is not an object. A throwing getter,
 * a Proxy or a throwing iterator makes it throw: the caller catches it.
 */
function snapshotDecls(list: readonly unknown[]): (DeclSnapshot | undefined)[] {
  const out: (DeclSnapshot | undefined)[] = []
  for (const v of list) {
    if (typeof v !== "object" || v === null) {
      out.push(undefined)
      continue
    }
    const o = v as Record<string, unknown>
    out.push({
      phase: o.phase,
      order: o.order,
      transform: o.transform,
      timeoutMs: o.timeoutMs,
      self: v,
    })
  }
  return out
}

/** A snapshot that passed {@link isDeclSnapshot}. */
type ValidDeclSnapshot = DeclSnapshot & {
  phase: ToolResultTransformDecl["phase"]
  order: number
  transform: (...a: unknown[]) => unknown
}

/** True when the snapshot is a valid decl: known phase, finite number order, function transform. */
function isDeclSnapshot(s: DeclSnapshot | undefined): s is ValidDeclSnapshot {
  return (
    s !== undefined &&
    typeof s.phase === "string" &&
    (TOOL_RESULT_PHASES as readonly string[]).includes(s.phase) &&
    isFiniteNumber(s.order) &&
    typeof s.transform === "function"
  )
}

/**
 * The stage transform of a snapshot (F7): a closure over the snapshot
 * function and its `this`. No `bind`: `bind` reads `length` and `name` of a
 * plugin function, and a Proxy function can throw there.
 */
function stageTransform(snap: ValidDeclSnapshot): ToolResultTransformDecl["transform"] {
  const fn = snap.transform
  const self = snap.self
  return (s: ToolResultStage, ctx?: unknown) =>
    fn.call(self, s, ctx) as ReturnType<ToolResultTransformDecl["transform"]>
}

/** The raw list of a plugin, in a box: an `await` does not read `.then` on it. */
interface RawList {
  value: unknown
}

/** The value of {@link importTransforms} when the entry file is missing. */
const MODULE_MISSING: unique symbol = Symbol("module-missing")

/**
 * Import the module and call its factory: the raw list, in a box. Only a
 * native Promise result is awaited, so this step reads no field of the list.
 * Throws on a failed import or a throwing factory.
 */
async function importTransforms(packageDir: string, entry: string): Promise<RawList> {
  const pkg = pluginPackageFor(packageDir)
  const mod = (await pkg.importModule(entry)) as { default?: unknown }
  const def = mod.default
  if (typeof def !== "function") return { value: def }
  const made: unknown = (def as () => unknown)()
  return { value: made instanceof Promise ? ((await made) as unknown) : made }
}

/**
 * Import the `toolResultTransforms` entry of one plugin and return its
 * entries. The default export is `ToolResultTransformDecl[]` or a function
 * that returns it (sync or async). Failures give one
 * `tool-result-chain.load-failed` diagnostic `{pluginId, reason}` and `[]`
 * ({@link LoaderChainFailReason}): `bad-raw`, `module-missing`,
 * `import-threw`, `timeout` (the import and the async factory did not settle
 * in `timeoutMs`, M1), `not-array`, and `decl-threw` (the list or a decl
 * threw when read, F3). A bad element is skipped with one
 * `tool-result-chain.decl-invalid` diagnostic `{pluginId, index}`. Each kept
 * decl gets `timeoutMs` (see {@link resolveStageTimeout}). A changed value
 * gives one `tool-result-chain.timeout-clamped` diagnostic per stage. Never
 * throws.
 */
export async function loadPluginTransforms(
  raw: unknown,
  packageDir: string,
  pluginId: string,
  relay: DiagnosticsRelay,
  timeoutMs: number = BOOT_IMPORT_TIMEOUT_MS,
): Promise<ToolResultChainEntry[]> {
  if (raw === undefined || raw === null) return []
  const fail = (reason: LoaderChainFailReason): [] => {
    warnPlugin(relay, "tool-result-chain.load-failed", pluginId, { reason })
    return []
  }
  const parsed = parseToolResultTransformsRaw(raw)
  if (parsed === undefined) return fail("bad-raw")
  let boxed: RawList | typeof MODULE_MISSING | typeof TIMED_OUT
  try {
    boxed = pluginPackageFor(packageDir).hasFile(parsed.entry)
      ? await raceImport(importTransforms(packageDir, parsed.entry), timeoutMs)
      : MODULE_MISSING
  } catch {
    return fail("import-threw")
  }
  if (boxed === MODULE_MISSING) return fail("module-missing")
  if (boxed === TIMED_OUT) return fail("timeout")
  // F3: ONE try. Every plugin-owned read (the list, its iteration, each decl
  // field) happens here, once. After the try, only the snapshot is used.
  let snaps: (DeclSnapshot | undefined)[]
  try {
    const list = boxed.value
    if (!Array.isArray(list)) return fail("not-array")
    snaps = snapshotDecls(list)
  } catch {
    return fail("decl-threw")
  }
  const out: ToolResultChainEntry[] = []
  snaps.forEach((d, index) => {
    if (!isDeclSnapshot(d)) {
      warnPlugin(relay, "tool-result-chain.decl-invalid", pluginId, { index })
      return
    }
    const timeout = resolveStageTimeout(d.timeoutMs, parsed.timeoutMs)
    const decl: ToolResultTransformDecl = Object.freeze({
      phase: d.phase,
      order: d.order,
      transform: stageTransform(d),
      timeoutMs: timeout.applied,
    })
    if (timeout.change !== undefined) {
      warnPlugin(relay, "tool-result-chain.timeout-clamped", pluginId, {
        phase: d.phase,
        requested: requestedData(timeout.change.requested),
        applied: timeout.applied,
        reason: timeout.change.reason,
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
 * `tool-result-chain.invalid` diagnostic ({@link ChainInvalidDiagnostic}).
 * Never throws. Boot goes on.
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
  // Each `e.decl` is the frozen object that `loadPluginTransforms` built from
  // the snapshot (F3): `phase` is a plain copied string, not a plugin getter.
  // So these reads touch no plugin-owned object and cannot throw.
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
  const data: ChainInvalidDiagnostic = {
    violations: v.violations.map((x) => x.kind).join(","),
    disabled: dropped.length,
    pluginIds: [...dropped].sort().join(","),
  }
  relay.warn("tool-result-chain.invalid", "", { ...data })
  return Object.freeze(kept)
}

/** The error name of `e`, for a diagnostic. */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "unknown"
}

/** Options of {@link bootSidebandRegistry}. Tests only. */
export interface SidebandBootOptions {
  /** Time limit for a codec module import, in ms. Default {@link BOOT_IMPORT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** A codec factory of one plugin, before it is set. */
interface CodecCandidate {
  plugin: string
  factory: SidebandCodecFactory
}

/**
 * Import the `sidebandCodec` module of one plugin and return its factory.
 * A failure gives one `sideband.codec-load-failed` diagnostic
 * `{pluginId, reason}` ({@link SidebandCodecLoadFailReason}) and `undefined`: `duplicate` (a codec came first),
 * `module-missing`, `timeout` (the import did not settle in `timeoutMs`,
 * M1), `not-function`, `import-threw`. Never throws.
 */
async function importCodec(
  p: LoadedPlugin,
  first: CodecCandidate | undefined,
  relay: DiagnosticsRelay,
  timeoutMs: number,
): Promise<CodecCandidate | undefined> {
  const plugin = p.manifest.id
  const codecDecl = p.manifest.sidebandCodec
  if (codecDecl === undefined) return undefined
  const failed = (reason: SidebandCodecLoadFailReason): undefined => {
    warnPlugin(relay, "sideband.codec-load-failed", plugin, { reason })
    return undefined
  }
  if (first !== undefined) return failed("duplicate")
  try {
    const pkg = pluginPackageFor(p.packageDir)
    if (!pkg.hasFile(codecDecl.entry)) return failed("module-missing")
    const mod = await raceImport(pkg.importModule(codecDecl.entry), timeoutMs)
    if (mod === TIMED_OUT) return failed("timeout")
    const factory = (mod as { default?: unknown }).default
    if (typeof factory !== "function") return failed("not-function")
    return { plugin, factory: factory as SidebandCodecFactory }
  } catch {
    return failed("import-threw")
  }
}

/** True when `v` has a `then` function. Reading `then` can throw: the caller catches it. */
function isThenable(v: unknown): boolean {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  )
}

/**
 * Wrap a plugin codec factory (CODEC rule). The factory stays lazy and
 * synchronous: the registry calls it on the first `codec()` call. A throw
 * gives the reason `error`, a thenable result gives the reason `async` (it is
 * not awaited). A failure emits ONE `sideband.codec-failed` diagnostic
 * `{pluginId, reason}` and is cached: then each call throws
 * `SidebandCodecMissingError`, the same as when no plugin gives a codec, and
 * the plugin factory is not called again.
 */
function guardCodecFactory(c: CodecCandidate, relay: DiagnosticsRelay): SidebandCodecFactory {
  let failed = false
  return (view) => {
    if (failed) throw new SidebandCodecMissingError()
    let reason: SidebandCodecFailReason | undefined
    let built: SidebandCodec | undefined
    try {
      const made: unknown = c.factory(view)
      if (isThenable(made)) {
        reason = "async"
        // A native rejected Promise must not be an unhandled rejection.
        if (made instanceof Promise) made.catch(() => {})
      } else {
        built = made as SidebandCodec
      }
    } catch {
      reason = "error"
    }
    if (reason !== undefined || built === undefined) {
      failed = true
      warnPlugin(relay, "sideband.codec-failed", c.plugin, { reason: reason ?? "error" })
      throw new SidebandCodecMissingError()
    }
    return built
  }
}

/** The contract that lets a required plugin declare core annotation kinds (design D1 a). */
export const SIDEBAND_CORE_KINDS_CONTRACT = "sideband.kinds.core"

/**
 * The plugin ids that can declare a core annotation kind: each plugin with
 * `required: true` that provides {@link SIDEBAND_CORE_KINDS_CONTRACT}. Pure.
 */
export function sidebandCoreKindOwners(plugins: readonly LoadedPlugin[]): ReadonlySet<string> {
  const owners = new Set<string>()
  for (const p of plugins) {
    const m = p.manifest
    if (m.required === true && (m.provides ?? []).includes(SIDEBAND_CORE_KINDS_CONTRACT)) {
      owners.add(m.id)
    }
  }
  return owners
}

/**
 * Build the sideband registry of one load: register the `sideband` kinds of
 * each plugin, set the first `sidebandCodec` factory (wrapped by
 * {@link guardCodecFactory}), then freeze (SB-REG-8). A rejected kind gives
 * one `sideband.kind-rejected` diagnostic. A core annotation kind registers
 * only for a plugin of {@link sidebandCoreKindOwners}. A failed codec import gives one
 * `sideband.codec-load-failed` diagnostic. The codec is not built here:
 * `codec()` builds it on the first call. Never throws.
 */
export async function bootSidebandRegistry(
  plugins: readonly LoadedPlugin[],
  relay: DiagnosticsRelay,
  opts: SidebandBootOptions = {},
): Promise<LoadedSidebandRegistry> {
  const registry = createSidebandRegistry({ coreKindOwners: sidebandCoreKindOwners(plugins) })
  const timeoutMs = opts.timeoutMs ?? BOOT_IMPORT_TIMEOUT_MS
  let codec: CodecCandidate | undefined
  for (const p of plugins) {
    const plugin = p.manifest.id
    const candidate = await importCodec(p, codec, relay, timeoutMs)
    codec ??= candidate
    for (const k of p.manifest.sideband ?? []) {
      try {
        // `ManifestSidebandKind` is `SidebandKind` without `owner`. The
        // registry sets `owner` (registry.ts:103).
        registry.register(k as SidebandKind, plugin)
      } catch (e) {
        warnPlugin(relay, "sideband.kind-rejected", plugin, { kind: k.kind, error: errorName(e) })
      }
    }
  }
  if (codec !== undefined) registry.setCodec(guardCodecFactory(codec, relay), codec.plugin)
  registry.freeze()
  return narrow(registry)
}

/**
 * The read-only view of a registry: a frozen object with no `register`,
 * `setCodec` or `freeze`, so no caller can change the registry after boot.
 * The registry itself is frozen too: a late `register` or `setCodec` throws
 * `SidebandRegistryFrozenError` (registry.ts, D3).
 */
function narrow(r: SidebandRegistry): LoadedSidebandRegistry {
  return Object.freeze({
    kind: (name: string) => r.kind(name),
    kinds: () => r.kinds(),
    codec: () => r.codec(),
  })
}

/** One API for each registry object. A registry belongs to one load. */
const SIDEBAND_APIS = new WeakMap<LoadedSidebandRegistry, SidebandApi>()

/**
 * The `SidebandApi` of `registry`: built on the first call, then the same
 * object. With no codec, `render` gives `""` and `diagnostics` gets one
 * `sideband.render-dropped` for each kind.
 */
export function sidebandApiFor(
  registry: LoadedSidebandRegistry,
  diagnostics: SidebandApiDiagnostics,
): SidebandApi {
  let api = SIDEBAND_APIS.get(registry)
  if (api === undefined) {
    api = createSidebandApi(registry, { diagnostics })
    SIDEBAND_APIS.set(registry, api)
  }
  return api
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
