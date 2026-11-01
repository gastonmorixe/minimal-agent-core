/**
 * Narrow public re-export of src/tools/tool-definitions.ts's
 * `TOOL_DEFINITIONS` metadata array only — tool listing/validation, not
 * execution (S34 exports-gap decision, Phase 0 / Bucket C).
 *
 * Deliberately NOT exported here: anything from `src/tools/tools.ts`,
 * the 1296-line tool-EXECUTION engine (`executeTool`, `execBash`, file
 * I/O, …). `TOOL_DEFINITIONS` lives in its own file precisely so a
 * metadata-only consumer (the host entry point's tool listing/validation) never
 * needs the execution engine.
 *
 * @module host-public/tool-catalog
 */
export { TOOL_DEFINITIONS } from "../tools/tool-definitions.ts"
