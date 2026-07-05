/**
 * Host adapter: bind the core tool set + plugin-contributed tools to the SDK
 * {@link ToolRegistry} port.
 *
 * Reproduces exactly what the legacy `Agent` assembles at
 * `src/agent/agent.ts`: `allTools = [...TOOL_DEFINITIONS, ...loader.getExtraTools()]`,
 * plus the presentation map (icon / color / headerKey keyed by tool name,
 * with alias slots mirrored from the loader's alias map).
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

/**
 * A {@link ToolRegistry} over the built-in {@link TOOL_DEFINITIONS} merged with
 * a {@link PluginLoader}'s `getExtraTools()`.
 *
 * The tool list is computed once at construction (plugins do not change
 * mid-run, matching the legacy loop's once-per-run assembly). `list()` returns
 * that fixed set in registration order: core tools first, then plugin tools.
 * `presentation()` exposes the icon/color/headerKey map, including alias slots.
 */
export class ToolRegistryAdapter implements ToolRegistry {
  private readonly tools: ToolDefinition[]
  private readonly presentationMap: ReadonlyMap<string, Presentation>

  constructor(loader: PluginLoader | null) {
    // Core built-ins first, then plugin-contributed tools, in loader order.
    // Byte-identical to `src/agent/agent.ts`'s `allTools`.
    this.tools = loader
      ? [...TOOL_DEFINITIONS, ...(loader.getExtraTools() as ToolDefinition[])]
      : [...TOOL_DEFINITIONS]

    // Presentation map: only tools that declare at least one cosmetic field
    // get a slot (same guard as the legacy builder).
    const pres = new Map<string, Presentation>()
    for (const t of this.tools) {
      if (t.icon || t.color || t.headerKey) {
        pres.set(t.name, { icon: t.icon, color: t.color, headerKey: t.headerKey })
      }
    }
    // Mirror canonical presentation into alias slots so a tool_use the model
    // emits under an old/legacy name still renders with the canonical
    // icon/color. Aliases are NOT advertised to the model (not in `tools`);
    // we read them straight from the loader, exactly as the legacy loop does.
    if (loader) {
      for (const [alias, canonical] of loader.getToolAliases()) {
        const p = pres.get(canonical)
        if (p && !pres.has(alias)) pres.set(alias, p)
      }
    }
    this.presentationMap = pres
  }

  /** All available tools, core-first then plugin, in registration order. */
  list(): ToolDefinition[] {
    return this.tools
  }

  /** Per-tool cosmetic presentation (icon / color / headerKey), incl. aliases. */
  presentation(): ReadonlyMap<string, Presentation> {
    return this.presentationMap
  }
}
