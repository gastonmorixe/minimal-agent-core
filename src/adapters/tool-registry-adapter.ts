/**
 * Host adapter: bind the core tool set + plugin-contributed tools to the SDK
 * {@link ToolRegistry} port.
 *
 * Assembles the advertised tool list:
 * `allTools = [...TOOL_DEFINITIONS, ...loader.getExtraTools()]`.
 *
 * The registry carries no tool presentation (spec S29). The CLI keeps its
 * own static presentation map, keyed by tool name (S41).

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
 * @module adapters/tool-registry-adapter
 */

import type { PluginLoader } from "../plugins/loader.ts"
import type { ToolDefinition, ToolRegistry } from "../sdk/ports.ts"
import { TOOL_DEFINITIONS } from "../tools/tools.ts"

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
}
