/**
 * Boot only the sideband registry, with no plugin handler import: discovery,
 * then {@link bootSidebandRegistry}. For a reader with no loader (CLI `dump`,
 * replay of old session text). Design section 2f.
 *
 * Plugin set: `PluginLoader.load` boots the kinds of its final plugins only.
 * This module applies the same tool and inline-tag collision skip (it needs
 * no handler import), in the same boot order. One difference stays: the
 * loader also skips a plugin whose tool handler module does not resolve.
 * This module imports no handler, so it keeps that plugin and its kinds.
 *
 * @module plugins/loader/sideband-only
 */

import { type Diagnostics, processDiagnostics } from "../../diagnostics/hub.ts"
import type { SidebandApi } from "../../sideband/types.ts"
import type { LoadedPlugin } from "../types.ts"

import { findToolCollision } from "./collisions.ts"
import { createDiagnosticsRelay } from "./diagnostics-relay.ts"
import { type DiscoveryOptions, discoverAndParsePackages, orderBootProviders } from "./discovery.ts"
import { computeEffectiveName } from "./helpers.ts"
import { installHostCoreResolver } from "./host-core-resolver.ts"
import { bootSidebandRegistry, sidebandApiFor } from "./tool-result-chain-boot.ts"
import { warnSink } from "./warn-sink.ts"

/** Options of {@link loadSidebandOnly}: the discovery options of the loader. */
export interface SidebandOnlyOptions
  extends Pick<DiscoveryOptions, "embeddedDir" | "userDir" | "roots" | "effectivePlatform"> {
  /** Diagnostics target. Default: the process handle. */
  diagnostics?: Diagnostics
  /** Plugin ids force-disabled by user config. Default: none. */
  disabledPluginIds?: Set<string>
  /** Plugin ids force-enabled by user config. Default: none. */
  enabledPluginIds?: Set<string>
  /** Core tool names that a plugin tool must not take (as for the loader). Default: none. */
  coreToolNames?: ReadonlySet<string>
}

/**
 * The plugins that the collision check of `PluginLoader.load` keeps, in
 * order. Same rules: a tool name or inline tag that a core tool or an
 * earlier plugin has skips the whole plugin. Canonical names use the same
 * prefix rule. No handler is imported.
 */
export function withoutToolCollisions(
  plugins: readonly LoadedPlugin[],
  coreToolNames: ReadonlySet<string>,
  logger: (msg: string) => void,
): LoadedPlugin[] {
  const toolIndex = new Set<string>()
  const aliasIndex = new Set<string>()
  const tagIndex = new Set<string>()
  const kept: LoadedPlugin[] = []
  for (const pkg of plugins) {
    const tools = pkg.manifest.tools ?? []
    const reason = findToolCollision(
      tools,
      { coreToolNames, toolIndex, aliasIndex, tagIndex },
      logger,
    )
    if (reason !== null) {
      logger(`skipping ${pkg.packageDir}: ${reason}`)
      continue
    }
    for (const h of tools) {
      if (h.trigger.type === "tool") {
        const t = h.trigger.tool
        const { canonical, migrationAlias } = computeEffectiveName(
          t.name,
          t.explicitName,
          pkg.manifest.name,
          pkg.manifest.camelName,
        )
        toolIndex.add(canonical)
        for (const a of t.aliases ?? []) aliasIndex.add(a)
        if (migrationAlias) aliasIndex.add(migrationAlias)
      } else if (h.trigger.type === "inline_tag") {
        tagIndex.add(h.trigger.tag)
      }
    }
    kept.push(pkg)
  }
  return kept
}

/**
 * Discover the plugins, boot the sideband kinds and the codec, and give the
 * `SidebandApi`. No tool, hook or provider module is imported. Never throws
 * for a bad plugin: discovery and boot report diagnostics.
 */
export async function loadSidebandOnly(opts: SidebandOnlyOptions = {}): Promise<SidebandApi> {
  const relay = createDiagnosticsRelay(opts.diagnostics ?? processDiagnostics())
  installHostCoreResolver()
  const discovered = discoverAndParsePackages({
    ...(opts.embeddedDir !== undefined ? { embeddedDir: opts.embeddedDir } : {}),
    ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
    ...(opts.roots !== undefined ? { roots: opts.roots } : {}),
    ...(opts.effectivePlatform !== undefined ? { effectivePlatform: opts.effectivePlatform } : {}),
    logger: warnSink(relay, "sideband-only"),
    diagnostics: relay,
    disabledPluginIds: opts.disabledPluginIds ?? new Set<string>(),
    enabledPluginIds: opts.enabledPluginIds ?? new Set<string>(),
  })
  const ordered = orderBootProviders(discovered.parsed, discovered.promptTemplateRaw)
  const plugins = withoutToolCollisions(
    ordered,
    opts.coreToolNames ?? new Set<string>(),
    warnSink(relay, "sideband-only"),
  )
  const registry = await bootSidebandRegistry(plugins, relay)
  return sidebandApiFor(registry, relay)
}
