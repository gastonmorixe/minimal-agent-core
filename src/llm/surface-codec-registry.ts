/**
 * Process-wide registry for generic endpoint wire-surface codecs.
 *
 * Provider plugins register codecs for surfaces they intentionally expose to
 * the generic endpoint provider. This is separate from `ProviderAdapter.surfaces`:
 * an adapter surface is not automatically generically callable unless its
 * provider registers a codec here.
 *
 * @module llm/surface-codec-registry
 */

import type { SurfaceCodec } from "@minimal-agent/plugin-api/llm/surface-codec"

const codecs = new Map<string, SurfaceCodec>()

/** Add or replace a codec by `surfaceId`. Last registration wins. */
export function registerSurfaceCodec(codec: SurfaceCodec): void {
  codecs.set(codec.surfaceId, codec)
}

/** Look up a registered surface codec. */
export function findSurfaceCodec(surfaceId: string): SurfaceCodec | undefined {
  return codecs.get(surfaceId)
}

/** List registered codecs in registration order. */
export function listSurfaceCodecs(): SurfaceCodec[] {
  return [...codecs.values()]
}

/** Clear the registry. Intended for test isolation. */
export function clearSurfaceCodecs(): void {
  codecs.clear()
}
