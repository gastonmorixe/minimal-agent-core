/**
 * Public re-export shim for `@minimal-agent/core/host/session-artifacts`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Read-only inventory of a saved session's on-disk artifacts (transcript,
 * index, sidecars, blobs, network capture), for history/inspection commands.
 * See `../session/session-artifacts.ts` for the full contract.
 *
 * @module host-public/session-artifacts
 */

export * from "../session/session-artifacts.ts"
