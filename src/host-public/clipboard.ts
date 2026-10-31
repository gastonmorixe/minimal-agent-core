/**
 * Public re-export shim for `@minimal-agent/core/host/clipboard`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * System-clipboard read (image + text) with Bun-native + subprocess
 * fallbacks across macOS/Windows/Linux. Any terminal/visual host wants this
 * exact logic rather than reimplementing it. See
 * `../media/clipboard.ts` for the full contract.
 *
 * @module host-public/clipboard
 */

export * from "../media/clipboard.ts"
