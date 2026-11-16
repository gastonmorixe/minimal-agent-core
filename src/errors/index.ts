/**
 * Core errors module: typed errors with no text, plus the renderer registry.
 * Exported as `@minimal-agent/core/errors`.
 *
 * @module errors
 */

export type { StoredProviderFact } from "../auth/errors.ts"
export {
  GenericEndpointAuthError,
  NoProviderCredentialsError,
  NoProviderSelectedError,
  UnhandledAuthTypeError,
} from "../auth/errors.ts"
export {
  InvalidAuthorizationCodeError,
  NoOAuthLoginProviderError,
  SignInTimeoutError,
  TokenExchangeError,
} from "../auth/oauth-errors.ts"

export { CompactNoProviderError } from "./compact.ts"
export { ContractCheckFailedError } from "./contract-check.ts"
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
