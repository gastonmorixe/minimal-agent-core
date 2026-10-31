/**
 * The `toolEnv` port (spec S24): width and other env values a tool may need
 * (for example, the `COLUMNS` / `LINES` a `Bash` child process inherits so
 * `tput cols`, `stty size`, or a script that reads `$COLUMNS` see a real
 * value). Core never reads the terminal size itself; a host that renders a
 * terminal supplies this port with its own view of it.
 *
 * @module sdk/tool-env
 */

/** Width and other env values a tool may need, from the host's view. */
export interface ToolEnvValues {
  /** Terminal width in columns, when the host knows one. */
  columns?: number
  /** Terminal height in rows, when the host knows one. */
  lines?: number
}

/** Supplies {@link ToolEnvValues}. The host implements this; core never reads a global. */
export interface ToolEnvPort {
  values(): ToolEnvValues
}

/** A `toolEnv` port that reports no known width (headless hosts). */
export const NOOP_TOOL_ENV: ToolEnvPort = { values: () => ({}) }
