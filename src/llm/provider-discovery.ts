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

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { type ProviderPlugin, registerProviderPlugin } from "./provider-plugin.ts"

interface ProviderDescriptor {
  id: string
  /** Module path (relative to the plugin dir) exporting the ProviderPlugin. */
  entry: string
  /** Named export to read; defaults to `default`. */
  export: string
}

function readDescriptor(dir: string): ProviderDescriptor | null {
  const path = join(dir, "provider.json")
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
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
  if (!existsSync(pluginsDir)) return []
  const out: Array<{ dir: string; descriptor: ProviderDescriptor }> = []
  for (const name of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, name)
    const descriptor = readDescriptor(dir)
    if (descriptor) out.push({ dir, descriptor })
  }
  return out
}

/**
 * Dynamically import every provider plugin declared under `pluginsDir`.
 * Skips descriptors whose module/export isn't a valid `ProviderPlugin`.
 *
 * @returns The discovered plugins (not yet registered).
 */
export async function discoverProviderPlugins(pluginsDir: string): Promise<ProviderPlugin[]> {
  const plugins: ProviderPlugin[] = []
  for (const { dir, descriptor } of findProviderPluginDirs(pluginsDir)) {
    const mod = (await import(join(dir, descriptor.entry))) as Record<string, unknown>
    const candidate = mod[descriptor.export]
    if (isProviderPlugin(candidate)) plugins.push(candidate)
  }
  return plugins
}

/**
 * Discover + register (NOT activate) every provider plugin under
 * `pluginsDir`. Call `activateProviderPlugins()` afterward to populate
 * the canonical registries. Returns the registered provider ids.
 */
export async function registerDiscoveredProviders(pluginsDir: string): Promise<string[]> {
  const plugins = await discoverProviderPlugins(pluginsDir)
  for (const plugin of plugins) registerProviderPlugin(plugin)
  return plugins.map((p) => p.id)
}
