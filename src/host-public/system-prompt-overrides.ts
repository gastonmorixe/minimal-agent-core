/**
 * Public re-export shim for `@minimal-agent/core/host/system-prompt-overrides`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/system-prompt-overrides.ts`: the
 * pure `--system-prompt`/`--append-system-prompt` override model and
 * resolver.
 *
 * Also folds in `../config/system-prompt-override-keys.ts` (the paired
 * env/config key-name table for the same override parts) rather than giving
 * it its own subpath, since the two are always consumed together.
 *
 * @module host-public/system-prompt-overrides
 */

export * from "../config/system-prompt-override-keys.ts"
export * from "../llm/system-prompt-overrides.ts"
