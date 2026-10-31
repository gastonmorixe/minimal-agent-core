/**
 * Public re-export shim for `@minimal-agent/core/host/effort-resolution`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../config/effort-resolution.ts`: the
 * CLI/env/config `--effort` precedence resolver plus model-capability
 * validation.
 *
 * @module host-public/effort-resolution
 */

export * from "../config/effort-resolution.ts"
