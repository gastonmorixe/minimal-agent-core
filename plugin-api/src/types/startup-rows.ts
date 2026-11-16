/**
 * Startup rows: the payload types of the `startup.rows` chain channel.
 *
 * Data only. A plugin adds one row to the startup tree the host prints at
 * boot. Plugins send semantic tones, never ANSI escapes. The host maps each
 * tone onto its own theme, and prints plain text in a non-TTY or under
 * `NO_COLOR`. Plugin authors import these types from
 * `@minimal-agent/core/plugin-api`.
 *
 * @module plugin-api/types/startup-rows
 */

/**
 * Semantic tone of one row part. The host picks the color. `"default"` (or
 * no tone) is the normal text color, `"dim"` is muted, `"accent"` marks a
 * name or a target, `"warn"` flags a problem, and `"ok"` marks a healthy
 * count.
 */
export type StartupRowTone = "default" | "dim" | "accent" | "warn" | "ok"

/** One styled run of text in a startup row. */
export interface StartupRowPart {
  /** Plain text. No ANSI escapes and no newlines. */
  text: string
  /** Semantic tone. Omitted means `"default"`. */
  tone?: StartupRowTone
}

/** One child line drawn under a startup row as an indented sub-tree. */
export interface StartupRowChild {
  /** Left column label of the child line. */
  label: string
  /** Value parts drawn after the aligned label. */
  value: StartupRowPart[]
}

/** One row of the startup tree, added by a plugin. */
export interface StartupRow {
  /** Left column label, for example `"hooks"`. */
  label: string
  /** Summary parts drawn after the aligned label. */
  summary: StartupRowPart[]
  /** Optional child lines. The host may cap how many it shows. */
  children?: StartupRowChild[]
  /** Optional sort key. Lower values print first. Ties keep listener order. */
  order?: number
}

/**
 * Chain payload of `startup.rows`. Each listener returns a new payload with
 * its row appended to `rows`, and never mutates the input.
 */
export interface StartupRowsPayload {
  /** Working directory of the session. */
  cwd: string
  /** Terminal width in columns. The host truncates each line to it. */
  cols: number
  /** Rows collected so far, in listener order. */
  rows: StartupRow[]
}
