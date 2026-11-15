/**
 * Public re-export shim for `@minimal-agent/core/host/auth`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../auth/auth.ts`: the neutral
 * `AuthResult`, `TokenAuthResult`, and `ProviderNativeAuthResult` types, and
 * the `AuthResult` -\> `ProviderAuth` mapper (`authResultToProviderAuth`,
 * also exported under its old name `legacyAuthToProviderAuth`).
 * Core holds no provider OAuth client (decision 39). Provider plugins own
 * login and refresh through the `oauthLogin` contract.
 *
 * @module host-public/auth
 */

export * from "../auth/auth.ts"
