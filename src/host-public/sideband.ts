/**
 * Public host entry of the sideband API (design section 2): the one
 * `SidebandApi` of a loader, a sideband-only boot for a host with no loader,
 * and the types.
 *
 * @module host-public/sideband
 */

import type { PluginLoader } from "../plugins/loader.ts"
import type { SidebandApi } from "../sideband/types.ts"

export { loadSidebandOnly, type SidebandOnlyOptions } from "../plugins/loader/sideband-only.ts"
export { NO_SIDEBAND, sidebandForPlugin } from "../sideband/api.ts"
export { SidebandKindUnknownError } from "../sideband/errors.ts"
export type {
  SidebandApi,
  SidebandAttrs,
  SidebandAttrValue,
  SidebandDisplay,
  SidebandDisplayMode,
  SidebandDisplayOptions,
  SidebandDisplaySegment,
  SidebandForm,
  SidebandKind,
  SidebandMessage,
  SidebandNode,
  SidebandQuery,
  SidebandReader,
  SidebandSpan,
  StreamScanner,
  StreamScanOptions,
} from "../sideband/types.ts"

/**
 * The `SidebandApi` of a loaded `PluginLoader`: the same object on each call.
 *
 * @param loader - A loader after `PluginLoader.load`.
 * @returns The API of the loader.
 */
export function sidebandOf(loader: Pick<PluginLoader, "sideband">): SidebandApi {
  return loader.sideband()
}
