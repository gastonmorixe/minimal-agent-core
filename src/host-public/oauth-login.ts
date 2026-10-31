/**
 * Public re-export shim for `@minimal-agent/core/host/oauth-login`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../auth/oauth-login.ts`: the PKCE/
 * device-code OAuth login flow any terminal host offering provider login
 * needs identically.
 *
 * @module host-public/oauth-login
 */

export * from "../auth/oauth-login.ts"
