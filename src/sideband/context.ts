/**
 * Plugin-facing sideband context.
 *
 * @packageDocumentation
 */

import { SidebandKindUnknownError } from "./errors.ts"
import type { PluginSidebandContext, SidebandRegistry } from "./types.ts"

/**
 * Build the context handed to plugins.
 *
 * @param registry - Registry that holds kinds and the codec.
 * @returns A context with render and parse.
 */
export function createPluginSidebandContext(registry: SidebandRegistry): PluginSidebandContext {
  return {
    render(kind, msg) {
      const codec = registry.codec()
      const decl = registry.kind(kind)
      if (!decl) throw new SidebandKindUnknownError(kind)
      return codec.render(decl, { ...msg, kind })
    },
    parse(text) {
      return registry.codec().parse(text)
    },
  }
}
