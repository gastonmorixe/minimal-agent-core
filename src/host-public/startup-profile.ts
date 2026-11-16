/**
 * Public re-export shim for `@minimal-agent/core/host/startup-profile`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Strict codec for the lead startup profile (`<sid>.profile.json`) that a
 * child session reads through `--startup-profile`. The type itself is in
 * `plugin-api/types/startup-profile`. See `../session/startup-profile.ts`.
 *
 * @module host-public/startup-profile
 */

export * from "../session/startup-profile.ts"
