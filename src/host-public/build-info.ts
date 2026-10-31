/**
 * Public re-export shim for `@minimal-agent/core/host/build-info`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * The agent's own build identity (provider-neutral semver), read from
 * `package.json` at module load. See `../utils/build-info.ts` for the
 * full contract.
 *
 * @module host-public/build-info
 */

export * from "../utils/build-info.ts"
