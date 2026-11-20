/**
 * Plugin-facing sideband context.
 *
 * @packageDocumentation
 */

import { createSidebandApi } from "./api.ts"
import type { PluginSidebandContext, SidebandApi, SidebandRegistry } from "./types.ts"

/**
 * Build the context handed to plugins: the full `SidebandApi` plus the raw
 * codec `parse`. With no codec, `render`, `example` and `parse` throw
 * `SidebandCodecMissingError` (the S1.1 rule of this context).
 *
 * @param registry - Registry that holds kinds and the codec.
 * @returns The API with `parse`.
 */
export function createPluginSidebandContext(registry: SidebandRegistry): PluginSidebandContext {
  const api = createSidebandApi(registry, { missingCodec: "throw" })
  // Copy the property descriptors, so the `ready` getter stays live.
  const ctx = Object.defineProperties({}, Object.getOwnPropertyDescriptors(api)) as SidebandApi
  return Object.assign(ctx, {
    parse(text: string) {
      return registry.codec().parse(text)
    },
  })
}
