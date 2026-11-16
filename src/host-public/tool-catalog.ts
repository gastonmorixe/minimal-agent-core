/**
 * Narrow public re-export of src/tools/tool-definitions.ts's metadata:
 * `BUILTIN_TOOL_NAMES` (names), `TOOL_SPECS` (schemas, no text) and
 * `TOOL_DEFINITIONS` (core fallback text, removed in P3) only — tool listing/validation, not
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
export {
  BUILTIN_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_SPECS,
  type ToolSpec,
} from "../tools/tool-definitions.ts"
