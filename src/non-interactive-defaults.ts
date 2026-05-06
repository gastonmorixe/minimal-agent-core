/**
 * Resolution helpers for the two switches that key off non-interactive
 * mode:
 *
 *   1. Whether to show the startup tree (banner + rows + closer).
 *   2. Which mode (if any) to enter on boot.
 *
 * Lifted into its own module so the precedence ladder (CLI > env > config
 * > built-in default) can be unit-tested without pulling the entire
 * `src/index.ts` startup graph. Pure: no I/O, no time, no globals.
 *
 * Non-interactive detection itself lives in `./extract-prompt.ts`; this
 * module just consumes the boolean.
 *
 * @module non-interactive-defaults
 */

import { extractPromptFromArgs } from "./extract-prompt.ts"

/**
 * Inputs for a single resolution call. Mirrors what `index.ts` already
 * has on hand — `args` (post-`normalizeArgs`), the relevant env subset,
 * and the user config slice.
 */
export interface ResolveInputs {
  args: readonly string[]
  env: { HEADER?: string; MODE?: string }
  config: { header?: boolean; mode?: string }
}

/**
 * True iff argv specifies a non-interactive prompt (`--prompt <text>`,
 * the `-` stdin sentinel, or a bare positional).
 *
 * Thin wrapper for symmetry with the resolvers — callers can pull just
 * this if all they want is the predicate.
 */
export function isNonInteractive(args: readonly string[]): boolean {
  return extractPromptFromArgs(args).kind !== "none"
}

/**
 * Read the value of a long flag from argv, supporting both
 * `--flag value` and `--flag=value`. Returns `undefined` if absent or
 * if the value slot is empty.
 */
function readFlagValue(args: readonly string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1) || undefined
  const idx = args.indexOf(name)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return undefined
}

/**
 * Resolve whether the startup tree (banner + rows) should be printed.
 *
 * Precedence (highest wins):
 *   1. `--no-header` / `--header` on the command line.
 *   2. `MINIMAL_AGENT_HEADER` env var: `0`/`false` → off, `1`/`true` → on.
 *   3. `config.header` boolean from `~/.minimal-agent/config.jsonc`.
 *   4. Default: hidden when non-interactive, shown otherwise.
 */
export function resolveShowHeader(inp: ResolveInputs): boolean {
  if (inp.args.includes("--no-header")) return false
  if (inp.args.includes("--header")) return true
  const env = inp.env.HEADER
  if (env === "0" || env === "false") return false
  if (env === "1" || env === "true") return true
  if (typeof inp.config.header === "boolean") return inp.config.header
  return !isNonInteractive(inp.args)
}

/**
 * Resolve the initial mode id to pass to `ModeManager`'s constructor.
 *
 * Precedence (highest wins):
 *   1. `--mode <id>` (or `--mode=<id>`) on the command line. The
 *      sentinel `none` clears any default.
 *   2. `MINIMAL_AGENT_MODE` env var (same `none` sentinel).
 *   3. `config.mode` from the user config.
 *   4. Default: `"ask"` for non-interactive, `pluginDefault` otherwise.
 *
 * Returns the id (string) or `null` to mean "no mode". The caller is
 * responsible for verifying the id matches a loaded mode — unknown ids
 * are passed through and `ModeManager.setMode` will silently no-op.
 *
 * @param pluginDefault The default supplied by plugins
 *   (`PluginLoader.getDefaultModeId()`), used when the user has
 *   expressed no preference and the session is interactive.
 */
export function resolveInitialModeId(
  inp: ResolveInputs,
  pluginDefault: string | null,
): string | null {
  const explicit = readFlagValue(inp.args, "--mode") ?? inp.env.MODE ?? inp.config.mode
  if (explicit !== undefined) return explicit === "none" ? null : explicit
  if (isNonInteractive(inp.args)) return "ask"
  return pluginDefault
}
