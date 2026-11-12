/**
 * Provider-plugin discovery.
 *
 * Scans a plugins directory for `llm-*` packages that declare a provider
 * via a `provider.json` descriptor, dynamically imports each one's
 * `ProviderPlugin` export, and (optionally) registers it.
 *
 * This is a DEDICATED, early loader, intentionally separate from the TUI
 * `PluginLoader` (`src/plugins/loader.ts`): provider plugins must be
 * registered BEFORE model resolution at startup, whereas the TUI loader
 * runs later (it loads tools / live-area slots once the REPL is coming
 * up). Keeping provider discovery here avoids that ordering hazard and
 * the heavier TUI manifest surface.
 *
 * `provider.json` shape:
 * ```json
 * { "id": "anthropic", "entry": "./index.ts", "export": "anthropicProviderPlugin" }
 * ```
 *
 * @module llm/provider-discovery
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import type {
  ModelRegistrar,
  ProviderAdapterRegistrar,
  ProviderAdapterView,
  ProviderModelSpec,
  ProviderSetupContext,
} from "@minimal-agent/core/plugin-api/llm/provider-plugin"
import type { SurfaceCodecRegistry } from "@minimal-agent/core/plugin-api/llm/surface-codec"

import { installHostCoreResolver } from "../plugins/loader/host-core-resolver.ts"
import { diskPluginPackage, embeddedPluginPackages, type PluginPackage } from "../plugins/source.ts"

import { registerModel, registerProvider, setDefaultModelId } from "./model-registry.ts"
import type { ProviderAdapter } from "./provider.ts"
import {
  listProviderPlugins,
  type ProviderPlugin,
  registerProviderPlugin,
} from "./provider-plugin.ts"
import {
  findSurfaceCodec,
  listSurfaceCodecs,
  registerSurfaceCodec,
} from "./surface-codec-registry.ts"

interface ProviderDescriptor {
  id: string
  /** Module path (relative to the plugin dir) exporting the ProviderPlugin. */
  entry: string
  /** Named export to read; defaults to `default`. */
  export: string
}

function readDescriptor(pkg: PluginPackage): ProviderDescriptor | null {
  let parsed: unknown
  try {
    const text = pkg.readText("provider.json")
    if (text === null) return null
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const o = parsed as Record<string, unknown>
  if (typeof o.id !== "string" || typeof o.entry !== "string") return null
  return {
    id: o.id,
    entry: o.entry,
    export: typeof o.export === "string" ? o.export : "default",
  }
}

function isProviderPlugin(v: unknown): v is ProviderPlugin {
  if (typeof v !== "object" || v === null) return false
  const p = v as Partial<ProviderPlugin>
  return typeof p.id === "string" && typeof p.register === "function"
}

/**
 * Directories under `pluginsDir` that declare a provider via
 * `provider.json`, sorted by directory name for deterministic order.
 */
export function findProviderPluginDirs(
  pluginsDir: string,
): Array<{ dir: string; descriptor: ProviderDescriptor }> {
  return findProviderPackages(pluginsDir).map(({ dir, descriptor }) => ({ dir, descriptor }))
}

/** One provider package: its dir, its descriptor, and its source. */
interface ProviderPackage {
  dir: string
  descriptor: ProviderDescriptor
  pkg: PluginPackage
}

/** {@link findProviderPluginDirs} with each package source. */
function findProviderPackages(pluginsDir: string): ProviderPackage[] {
  if (!existsSync(pluginsDir)) return []
  const out: ProviderPackage[] = []
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name)
    const pkg = diskPluginPackage(dir)
    const descriptor = readDescriptor(pkg)
    if (descriptor) out.push({ dir, descriptor, pkg })
  }
  return out
}

/** The provider packages of the registered embedded table, by name. */
function findEmbeddedProviderPackages(): ProviderPackage[] {
  const out: ProviderPackage[] = []
  for (const pkg of embeddedPluginPackages()) {
    const descriptor = readDescriptor(pkg)
    if (descriptor) out.push({ dir: pkg.dir, descriptor, pkg })
  }
  return out
}

/** Import the `ProviderPlugin` of each package. Skips invalid exports. */
async function importProviderPlugins(found: ProviderPackage[]): Promise<ProviderPlugin[]> {
  const plugins: ProviderPlugin[] = []
  for (const { descriptor, pkg } of found) {
    // A disk package resolves `entry` against its dir, and `resolve`
    // anchors a relative dir to cwd, the same as before.
    const mod = (await pkg.importModule(descriptor.entry)) as Record<string, unknown>
    const candidate = mod[descriptor.export]
    if (isProviderPlugin(candidate)) plugins.push(candidate)
  }
  return plugins
}

/**
 * Dynamically import every provider plugin declared under `pluginsDir`.
 * Skips descriptors whose module/export isn't a valid `ProviderPlugin`.
 *
 * @returns The discovered plugins (not yet registered).
 */
export async function discoverProviderPlugins(pluginsDir: string): Promise<ProviderPlugin[]> {
  // Provider plugins load before the TUI loader, so they install the
  // host-core resolver too: their `@minimal-agent/core/*` imports get the
  // host's copy.
  installHostCoreResolver()
  return importProviderPlugins(findProviderPackages(pluginsDir))
}

/**
 * Import every provider plugin of the registered embedded table
 * (`registerEmbeddedPlugins`). Empty when no table is registered.
 *
 * @returns The discovered plugins (not yet registered).
 */
export async function discoverEmbeddedProviderPlugins(): Promise<ProviderPlugin[]> {
  return importProviderPlugins(findEmbeddedProviderPackages())
}

/**
 * Discover + register (NOT activate) every provider plugin under one or
 * more roots. Call `activateProviderPlugins()` afterward to populate the
 * canonical registries. Returns the registered provider ids.
 *
 * Accepts a single dir (back-compat) or an array of dirs. The host
 * computes the roots (S40). Roots are scanned in order. The FIRST
 * occurrence of a provider id wins and later duplicates are skipped, so an
 * earlier root shadows a later one. A missing root contributes nothing.
 * The packages of a registered embedded table (`registerEmbeddedPlugins`)
 * come after every root, so any disk copy of a provider id wins.
 */
export async function registerDiscoveredProviders(
  pluginsDirs: string | readonly string[],
): Promise<string[]> {
  const roots = typeof pluginsDirs === "string" ? [pluginsDirs] : pluginsDirs
  const registered: string[] = []
  const seen = new Set<string>()
  const take = (plugin: ProviderPlugin) => {
    if (seen.has(plugin.id)) return
    seen.add(plugin.id)
    registerProviderPlugin(plugin)
    registered.push(plugin.id)
  }
  for (const root of roots) {
    for (const plugin of await discoverProviderPlugins(root)) take(plugin)
  }
  // The registered embedded table last, so every disk root shadows it.
  for (const plugin of await discoverEmbeddedProviderPlugins()) take(plugin)
  return registered
}

// ---------------------------------------------------------------------------
// Provider setup-context (the models:register seam for the provider loader)
// ---------------------------------------------------------------------------

/**
 * Build the {@link ProviderSetupContext} the host hands a provider plugin at
 * activation. It exposes the live model registry as a provider-neutral
 * {@link ModelRegistrar} (the `models:register` capability), so a provider's
 * `register(ctx)` contributes its catalog through `ctx.models.register`
 * instead of importing `registerModel` / `setDefaultModelId` from `src/`.
 *
 * This is the provider-loader analogue of `buildPluginHost` (the TUI
 * `ctx.host`): the host owns the registry singleton and the registrar is a thin
 * provider-neutral facade over it. `surfaceId` is an opaque provider-defined
 * string on both sides, so the registrar forwards the spec straight through to
 * the real `registerModel`.
 *
 * Keeping this here (rather than in `buildPluginHost`) is deliberate: provider
 * plugins load through this dedicated early loader, NOT the TUI loader, and they
 * need the registry BEFORE model resolution at startup. See the provider/plugin
 * convergence note in `private/decoupling-refactor-work/reports/D-net-seam.md` §3.
 *
 * @returns A fresh setup context bound to the process-wide model registry.
 */
export function buildProviderSetupContext(): ProviderSetupContext {
  const models: ModelRegistrar = {
    register(spec: ProviderModelSpec): void {
      // `surfaceId` is an opaque provider-defined string on both sides. A bad
      // surface id surfaces later at dispatch (`adapter.run`), identical to the
      // direct-import path.
      registerModel(spec)
    },
    setDefault(id: string | null): void {
      setDefaultModelId(id)
    },
  }
  // Provider-adapter registrar: the `providers:register` capability. A plugin
  // hands a provider-neutral `ProviderAdapterView` (leaf types, `surfaces` as
  // plain strings); the host narrows it back to its token-bearing
  // `ProviderAdapter` port as it forwards to the real `registerProvider`. The
  // host is allowed to name surfaces; the contract package is not. The view is
  // structurally a subset of `ProviderAdapter` (it omits host-only optional
  // hooks), so the cast is a widening to the richer port — a bad surface id
  // surfaces later at dispatch, identical to the direct-import path.
  const providers: ProviderAdapterRegistrar = {
    register(adapter: ProviderAdapterView): void {
      registerProvider(adapter as unknown as ProviderAdapter)
    },
  }
  const surfaceCodecs: SurfaceCodecRegistry = {
    register(codec): void {
      registerSurfaceCodec(codec)
    },
    find(surfaceId) {
      return findSurfaceCodec(surfaceId)
    },
    list() {
      return listSurfaceCodecs()
    },
  }
  return { models, providers, surfaceCodecs }
}

/**
 * Activate every registered provider plugin WITH a host setup context: calls
 * each plugin's `register(ctx)` so it can contribute its catalog through
 * `ctx.models` (the `models:register` capability) instead of importing the
 * registry from `src/`. This is the context-carrying counterpart of
 * `activateProviderPlugins()` (which calls `register()` with no arguments).
 *
 * Idempotent because `register()` is. Returns the activated provider ids.
 *
 * This is the provider-loader convergence injection point (D-net-seam §3): the
 * agent entrypoint can switch from `activateProviderPlugins()` to this once the
 * sibling provider plugins (anthropic, openrouter) adopt the ctx-driven
 * `register(ctx)` path. Until then both call paths coexist — a plugin's
 * `register(ctx?)` reads `ctx?.models` when present and falls back to its own
 * wiring when absent, so this is safe to adopt provider-by-provider.
 *
 * @param ctx - Setup context (defaults to a fresh {@link buildProviderSetupContext}).
 * @returns The activated provider ids.
 */
export function activateDiscoveredProviders(
  ctx: ProviderSetupContext = buildProviderSetupContext(),
): string[] {
  const activated: string[] = []
  for (const plugin of listProviderPlugins()) {
    plugin.register(ctx)
    activated.push(plugin.id)
  }
  return activated
}
