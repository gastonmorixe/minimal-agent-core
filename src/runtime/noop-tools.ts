/**
 * Headless tool defaults for `createRuntime`'s sessions (spec v2 section
 * 2.3, S47).
 *
 * `AgentCoreConfig.toolRegistry` / `.toolExecutor` are required fields: the
 * CLI fills them with its plugin + built-in tool catalog
 * (`src/adapters/`). A pure-core runtime has no plugin loader and
 * no built-in tool executor of its own (that is host/CLI territory), so a
 * session with no caller-supplied tools advertises none and runs a
 * plain, tool-free turn. A caller that wants tools passes its own
 * `toolRegistry` / `toolExecutor` to `runtime.openSession`.
 *
 * @module runtime/noop-tools
 */

import type { ToolExecutor, ToolRegistry } from "../sdk/ports.ts"

/** Advertises no tools. */
export const EMPTY_TOOL_REGISTRY: ToolRegistry = { list: () => [] }

/**
 * Fails any call clearly instead of silently doing nothing. Unreachable
 * with {@link EMPTY_TOOL_REGISTRY} (the model is never offered a tool to
 * call), so this only fires when a caller supplies a `toolRegistry` without
 * a matching `toolExecutor`.
 *
 * The text is the `tool_result.no_executor` kind with `site: "session"`
 * (no provider: "").
 */
export const NO_TOOLS_EXECUTOR: ToolExecutor = {
  execute: async (toolUse, _signal, context) => ({
    content:
      context?.text?.resolve("tool_result.no_executor", { name: toolUse.name, site: "session" }) ??
      "",
    isError: true,
  }),
}
