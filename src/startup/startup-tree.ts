/**
 * Compatibility re-export for the startup tree renderer.
 *
 * The implementation lives under `src/ui/startup/` because it owns terminal
 * drawing, layout, and spinner chrome. Keep this shim so startup orchestration
 * code can migrate imports incrementally.
 *
 * @module startup/startup-tree
 */

export * from "../ui/startup/tree.ts"
