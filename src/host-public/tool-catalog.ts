/**
 * Narrow public re-export of src/tools/tool-definitions.ts's metadata:
 * `BUILTIN_TOOL_NAMES` (names) and `TOOL_SPECS` (schemas, no text) only —
 * tool listing/validation, not execution (S34 exports-gap decision, Phase 0 /
 * Bucket C). Tool text comes from the `text.tools` providers
 * (`buildToolDefinitions`); core holds none.
 *
 * Deliberately NOT exported here: anything from `src/tools/tools.ts`,
 * the 1296-line tool-EXECUTION engine (`executeTool`, `execBash`, file
 * I/O, …). The specs live in their own file precisely so a
 * metadata-only consumer (the host entry point's tool listing/validation) never
 * needs the execution engine.
 *
 * Also the time limit rules of Bash (`src/tools/bash-timeout.ts`, pure), so
 * a host can show the limit of a running call with no copy of the constants.
 *
 * @module host-public/tool-catalog
 */
export {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  type BashTimeout,
  resolveBashTimeout,
} from "../tools/bash-timeout.ts"
export { BUILTIN_TOOL_NAMES, TOOL_SPECS, type ToolSpec } from "../tools/tool-definitions.ts"
