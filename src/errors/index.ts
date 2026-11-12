/**
 * Core errors module: typed errors with no text, plus the renderer registry.
 * Exported as `@minimal-agent/core/errors`.
 *
 * @module errors
 */

export { CoreError, FOREIGN_ERROR_KIND } from "./core-error.ts"
export { isCoreErrorJson } from "./guard.ts"
export { InvariantError, invariant } from "./invariant.ts"
export { createErrorRendererRegistry, HOST_OWNER_ID } from "./registry.ts"
export type {
  CoreErrorJson,
  ErrorRenderer,
  ErrorRendererRegistry,
  ForeignErrorJson,
  JsonValue,
} from "./types.ts"
