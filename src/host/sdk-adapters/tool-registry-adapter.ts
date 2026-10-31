/**
 * Host adapter: bind the core tool set + plugin-contributed tools to the SDK
 * {@link ToolRegistry} port.
 *
 * Assembles the advertised tool list:
 * `allTools = [...TOOL_DEFINITIONS, ...loader.getExtraTools()]`.
 *
 * `presentation()` is kept for its existing callers (`ToolExecutorAdapter`,
 * `build-agent-core.ts`) but now always returns an empty map: `S29`/`S31`
 * dropped the cosmetic `icon` / `color` / `headerKey` fields from both
 * `ToolDefinition` and the plugin loader's tool-building path, so there is
 * no longer a source to read them from. The CLI's own static presentation
 * map (S41) replaces this.
 *

 * ### Mode filtering — deliberately NOT applied here
 *
 * The request body advertises EVERY tool regardless of the active mode; mode
 * gating happens at DISPATCH time inside `executeToolRound`
 * (`modeManager.isToolAllowed`), which synthesizes a teaching error tool_result
 * for a disallowed call. This keeps the cached tool schema array byte-stable
 * across mode toggles (the prompt-cache prefix must not depend on mode). The
 * legacy loop does the same, and `ModeManager.filterTools` is now a deprecated
 * no-op pass-through. So the registry lists all tools and lets the executor
 * gate. Matching that is what keeps golden-parity (G1) intact.
 *
 * @module host/sdk-adapters/tool-registry-adapter
 */

import type { PluginLoader } from "../../plugins/loader.ts"
import type { ToolDefinition, ToolRegistry } from "../../sdk/ports.ts"
import { TOOL_DEFINITIONS } from "../../tools/tools.ts"

/** Cosmetic presentation slot for one tool (transcript header rendering). */
type Presentation = { icon?: string; color?: string; headerKey?: string }

/** Always empty: neither `ToolDefinition` nor a plugin tool carries these fields anymore (S29/S31). */
const EMPTY_PRESENTATION: ReadonlyMap<string, Presentation> = new Map()

/**
 * A {@link ToolRegistry} over the built-in {@link TOOL_DEFINITIONS} merged with
 * a {@link PluginLoader}'s `getExtraTools()`.
 *
 * The tool list is computed once at construction (plugins do not change
 * mid-run, matching the legacy loop's once-per-run assembly). `list()` returns
 * that fixed set in registration order: core tools first, then plugin tools.
 */
export class ToolRegistryAdapter implements ToolRegistry {
  private readonly tools: ToolDefinition[]

  constructor(loader: PluginLoader | null) {
    // Core built-ins first, then plugin-contributed tools, in loader order.
    this.tools = loader
      ? [...TOOL_DEFINITIONS, ...(loader.getExtraTools() as ToolDefinition[])]
      : [...TOOL_DEFINITIONS]
  }

  /** All available tools, core-first then plugin, in registration order. */
  list(): ToolDefinition[] {
    return this.tools
  }

  /** Always empty now; see the module doc. */
  presentation(): ReadonlyMap<string, Presentation> {
    return EMPTY_PRESENTATION
  }
}
