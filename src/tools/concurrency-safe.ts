/**
 * Concurrency-safe resolver: it tells the scheduler which tool calls of a
 * batch may overlap.
 *
 * A tool call is concurrency-safe only when the tool opts in. The default is
 * a serial call. The decision has two steps (SPEC X2):
 *
 * 1. Before admission: {@link ConcurrencySafeResolver.toolFlag} gives the
 *    flag of the tool. A built-in tool has the flag when it is in
 *    {@link CONCURRENCY_SAFE_BUILTIN_TOOLS}. A plugin tool has the flag when
 *    its manifest sets `trigger.tool.concurrencySafe: true` and the handler
 *    is not `interactive`. A tool with `interactive: true` always makes a
 *    serial call.
 * 2. After admission: {@link ConcurrencySafeResolver.isCallConcurrencySafe}
 *    gets the input that a hook may have rewritten. It is the flag AND the
 *    result of the optional `concurrencySafe(input)` export of the plugin
 *    handler. Only `true` counts. A throw makes a serial call.
 *
 * Pure: no timers, no I/O.
 *
 * @module tools/concurrency-safe
 */

import type { ToolConcurrencySafe } from "../../plugin-api/src/types/plugin.ts"
import type { ToolConcurrencyPolicy } from "../sdk/ports.ts"

import { CONCURRENCY_SAFE_BUILTIN_TOOLS } from "./tools.ts"

/**
 * The concurrency facts of one plugin tool, from the plugin loader. `flag`
 * is already false for an `interactive` handler.
 */
export interface PluginToolConcurrency {
  /** Manifest `concurrencySafe: true` and the handler is not `interactive`. */
  readonly flag: boolean
  /** The optional `concurrencySafe(input)` export of the handler module. */
  readonly perInput?: ToolConcurrencySafe
}

/**
 * The part of the plugin loader that the resolver reads. `hasTool` is true
 * for a plugin tool name or alias. `toolConcurrency` gives the facts of that
 * tool, or `undefined` when no plugin has the name.
 */
export interface PluginToolConcurrencySource {
  hasTool(name: string): boolean
  toolConcurrency(name: string): PluginToolConcurrency | undefined
}

/** The two-step decision that the scheduler uses (the SDK port shape). */
export type ConcurrencySafeResolver = ToolConcurrencyPolicy

/** Every call is a serial call (no plugin source and no built-in flag). */
export const SERIAL_ONLY_RESOLVER: ConcurrencySafeResolver = {
  toolFlag: () => ({ flag: false }),
  isCallConcurrencySafe: () => false,
}

/**
 * Run the per-input function of a tool. Only a return value of `true` makes
 * the call concurrency-safe. A throw or any other value gives false.
 */
export function runPerInputCheck(
  perInput: ToolConcurrencySafe,
  input: Record<string, unknown>,
): boolean {
  try {
    return perInput(input) === true
  } catch {
    return false
  }
}

/**
 * Build the resolver. A plugin tool wins over a built-in tool with the same
 * name, in the same order as the dispatch of the tool round
 * (`loader.hasTool` first). `loader` null: built-in tools only.
 *
 * The `typeof === "function"` guard: tests pass partial loader stubs. A
 * loader without `toolConcurrency` makes every plugin tool a serial call.
 */
export function createConcurrencySafeResolver(
  loader: Partial<PluginToolConcurrencySource> | null,
): ConcurrencySafeResolver {
  const plugin = (name: string): PluginToolConcurrency | null | undefined => {
    if (!loader || typeof loader.hasTool !== "function" || !loader.hasTool(name)) return undefined
    if (typeof loader.toolConcurrency !== "function") return null
    return loader.toolConcurrency(name) ?? null
  }
  return {
    toolFlag(toolName) {
      const p = plugin(toolName)
      if (p !== undefined) return { flag: p?.flag === true }
      return { flag: CONCURRENCY_SAFE_BUILTIN_TOOLS.has(toolName) }
    },
    isCallConcurrencySafe(toolName, input) {
      const p = plugin(toolName)
      if (p === undefined) return CONCURRENCY_SAFE_BUILTIN_TOOLS.has(toolName)
      if (!p || p.flag !== true) return false
      return p.perInput ? runPerInputCheck(p.perInput, input) : true
    },
  }
}
