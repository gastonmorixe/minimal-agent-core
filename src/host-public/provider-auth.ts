/**
 * Public re-export shim for `@minimal-agent/core/host/provider-auth`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Maps a stored `ProviderAuth` into the legacy `AuthResult` shape and
 * resolves startup credentials for the selected provider
 * (`resolveStartupAuth`, `describeStartupAuth`). See
 * `../auth/provider-auth.ts` for the full contract.
 *
 * @module host-public/provider-auth
 */

export * from "../auth/provider-auth.ts"
