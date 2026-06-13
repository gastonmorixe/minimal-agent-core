/**
 * Compatibility re-export for the first-run welcome card.
 *
 * The implementation lives under `src/ui/chrome/` because it owns terminal
 * drawing and layout. Keep this shim so older imports continue to compile
 * while startup code uses the UI path directly.
 *
 * @module first-run
 */

export * from "./ui/chrome/first-run.ts"
