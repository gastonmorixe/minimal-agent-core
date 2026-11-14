/**
 * Typed OAuth login errors. They hold facts and no text: a host renders them.
 *
 * @module auth/oauth-errors
 */

import { CoreError } from "../errors/core-error.ts"

/** The sign-in wait ran out. Also used as the abort reason of the deadline. */
export class SignInTimeoutError extends CoreError {
  static readonly kind = "SignInTimeoutError"
  declare readonly kind: "SignInTimeoutError"
}

/** The token endpoint refused the authorization code (HTTP 401). */
export class InvalidAuthorizationCodeError extends CoreError {
  static readonly kind = "InvalidAuthorizationCodeError"
  declare readonly kind: "InvalidAuthorizationCodeError"
}

/** The token endpoint answered with another failure status. */
export class TokenExchangeError extends CoreError {
  static readonly kind = "TokenExchangeError"
  declare readonly kind: "TokenExchangeError"

  constructor(
    readonly status: number,
    /** Full response body. The host decides how much to show. */
    readonly body: string,
  ) {
    super()
  }
}

/** No OAuth login provider is registered. */
export class NoOAuthLoginProviderError extends CoreError {
  static readonly kind = "NoOAuthLoginProviderError"
  declare readonly kind: "NoOAuthLoginProviderError"
}
