/**
 * Compatibility re-export for the UI style helpers.
 *
 * The implementation lives at `src/ui/style/ansi.ts`; this module stays so
 * older imports under `agent/*` continue to work while UI code is migrated.
 *
 * @module agent/ansi
 */

export { c, faintThinkingChunk, formatAbortedEcho } from "../ui/style/ansi.ts"
