/**
 * Public re-export shim for `@minimal-agent/core/host/provider-session`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/provider-session.ts`: the
 * provider-neutral session-metadata resolver the status bar and startup use.
 *
 * @module host-public/provider-session
 */

export * from "../llm/provider-session.ts"
