/**
 * Re-export shim — cooperative file locking moved to the leaf contract
 * package `@minimal-agent/plugin-api`.
 *
 * The implementation now lives at `plugin-api/src/utils/file-lock.ts` so the
 * host locking path (`src/tools.ts`, `src/binaries/store.ts`) AND the external
 * `file-lock` plugin resolve the same pure, dependency-free module. This file
 * stays at the old core path for back-compat with existing importers.
 *
 * @module file-lock
 */

export * from "@minimal-agent/plugin-api/utils/file-lock"
