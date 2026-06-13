/**
 * Compatibility re-export for the diff-view plugin's renderer.
 *
 * The implementation lives in the leaf plugin-api package so host replay,
 * core diff previews, and this plugin consume one renderer instead of keeping
 * byte-identical copies in sync.
 *
 * @module diff-view/handlers/render
 */

export { renderUnifiedDiff } from "@minimal-agent/plugin-api/utils/unified-diff"
