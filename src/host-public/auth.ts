/**
 * Public re-export shim for `@minimal-agent/core/host/auth`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../auth/auth.ts`: the neutral
 * `AuthResult`, `TokenAuthResult`, and `ProviderNativeAuthResult` types.
 * Core holds no provider OAuth client (decision 39). Provider plugins own
 * login and refresh through the `oauthLogin` contract.
 *
 * Also bundles `legacyAuthToProviderAuth` from `../llm/adapter-legacy.ts`
 * (a single function out of that 509-line legacy bridge module — the
 * `AuthResult` -\> `ProviderAuth` mapper) rather than giving it its own
 * subpath or exporting the whole adapter-legacy module, per the S34
 * exports-gap decision.
 *
 * @module host-public/auth
 */

export * from "../auth/auth.ts"
export { legacyAuthToProviderAuth } from "../llm/adapter-legacy.ts"
