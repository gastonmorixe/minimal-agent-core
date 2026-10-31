/**
 * Public re-export shim for `@minimal-agent/core/host/auth-store`.
 *
 * Lives under `src/host-public/` (not `src/auth/`) only so its path satisfies
 * `public-api.test.ts`'s "every export target resolves inside src/sdk,
 * src/host-public, or plugin-api/src" rule; the real implementation stays at
 * `../auth/auth-store.ts`. The credential store (file-backed vault at
 * `~/.minimal-agent/auth.jsonc`) any terminal host implementing
 * `login`/`logout`/`auth status` needs.
 *
 * @module host-public/auth-store
 */

export * from "../auth/auth-store.ts"
