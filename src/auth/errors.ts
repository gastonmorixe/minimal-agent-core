/**
 * Typed auth errors. They hold facts and no text: a host renders them.
 *
 * @module auth/errors
 */

import { CoreError } from "../errors/core-error.ts"

/** One credentialed provider, grouped by provider id. */
export type StoredProviderFact = {
  readonly providerId: string
  /** Credential labels of the provider, no duplicates, in store order. */
  readonly labels: readonly string[]
  /** Example model ids registered for the provider. */
  readonly exampleModels: readonly string[]
}

/** No provider is selected for the model. */
export class NoProviderSelectedError extends CoreError {
  static readonly kind = "NoProviderSelectedError"
  declare readonly kind: "NoProviderSelectedError"

  constructor(
    readonly modelId: string,
    readonly credentialedProviders: readonly StoredProviderFact[],
  ) {
    super()
  }
}

/** The selected provider has no stored credentials. */
export class NoProviderCredentialsError extends CoreError {
  static readonly kind = "NoProviderCredentialsError"
  declare readonly kind: "NoProviderCredentialsError"

  constructor(
    readonly providerId: string,
    readonly modelId: string,
    readonly credentialedProviders: readonly StoredProviderFact[],
  ) {
    super()
  }
}

/** A generic-endpoint auth flag is missing. */
export class GenericEndpointAuthError extends CoreError {
  static readonly kind = "GenericEndpointAuthError"
  declare readonly kind: "GenericEndpointAuthError"

  constructor(
    readonly authType: "api-key" | "bearer" | "custom-header",
    readonly missing: "api-key" | "auth-header",
  ) {
    super()
  }
}

/** A generic-endpoint auth type that the code does not handle. */
export class UnhandledAuthTypeError extends CoreError {
  static readonly kind = "UnhandledAuthTypeError"
  declare readonly kind: "UnhandledAuthTypeError"

  constructor(readonly authType: string) {
    super()
  }
}
