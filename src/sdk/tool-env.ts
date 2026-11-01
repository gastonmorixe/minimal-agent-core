/**
 * The `toolEnv` port (spec S24): env values a spawned tool may need. A
 * terminal host uses it to give a `Bash` child its terminal size, so
 * `tput cols`, `stty size`, or a script that reads the width see a real
 * value. Core never reads the terminal size and never picks env names for
 * it. The host supplies the names and the values.
 *
 * @module sdk/tool-env
 */

/** Env values a tool may need, from the host's view. */
export interface ToolEnvValues {
  /**
   * Env values to add to a spawned tool's process env. Read once at spawn.
   * Core keeps its own safety values (for example `TERM=dumb`) over these.
   */
  env?: Readonly<Record<string, string>>
}

/** Supplies {@link ToolEnvValues}. The host implements this; core never reads a global. */
export interface ToolEnvPort {
  values(): ToolEnvValues
}

/** A `toolEnv` port that adds no env values (headless hosts). */
export const NOOP_TOOL_ENV: ToolEnvPort = { values: () => ({}) }
