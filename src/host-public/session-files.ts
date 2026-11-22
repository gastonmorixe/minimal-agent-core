/**
 * Public re-export shim for `@minimal-agent/core/host/session-files`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * The `sessions:files` factory, for a host that builds the API itself (for
 * example the CLI UI loader). The core plugin host grants the same API under
 * the `sessions:files` capability. See
 * `../plugins/host/providers/session-files.ts` for the full contract.
 *
 * @module host-public/session-files
 */

export * from "../plugins/host/providers/session-files.ts"
