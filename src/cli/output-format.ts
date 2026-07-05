/**
 * The `--output-format` resolver for the non-interactive CLI.
 *
 * One flag, three values: `text` (human, the default), `json` (a buffered
 * structured event stream), and `stream-json` (the same event stream, flushed
 * live token-by-token). `--json` is kept as a documented alias for
 * `--output-format json`.
 *
 * This module is a PURE resolver: no I/O, no `process`, no host imports. It
 * takes the already-extracted flag values and returns the resolved format, so
 * `parse-argv.ts` can fold it into {@link CliOptions} alongside every other
 * option, and a test can assert precedence without spawning a process.
 *
 * Precedence ladder (highest wins):
 *   1. a valid `--output-format <value>`
 *   2. `--json` (alias for `json`)
 *   3. `text` (default)
 *
 * An absent or unrecognized `--output-format` value falls through to the next
 * rung rather than throwing — the resolver is non-throwing like the rest of
 * `parse-argv.ts`. The entry point can use {@link isOutputFormat} to warn on a
 * malformed value if it wants; the resolver itself never fails a run.
 *
 * Design principles (from software-best-design-patterns):
 *   - Functional core, imperative shell: a pure input→value transform.
 *   - Discriminated union: {@link OutputFormat} is a closed string-literal set
 *     so downstream `switch` narrows it exhaustively.
 *
 * @module cli/output-format
 */

/**
 * The non-interactive output format selected on the CLI.
 *
 * - `text`: human output. Progress to stderr; the final answer to stdout only
 *   when piped (the existing pipe convention). This is the default and its
 *   behavior is byte-identical to today's default path.
 * - `json`: a buffered {@link AgentEvent} JSONL stream. Events are available;
 *   a consumer that wants a single object reads the terminal `item_completed`.
 * - `stream-json`: the same JSONL stream, but every event is flushed the
 *   instant it is emitted (and, from Phase 3, includes token-level
 *   `text_delta` / `thinking_delta` events).
 */
export type OutputFormat = "text" | "json" | "stream-json"

/** The three valid `--output-format` values, for validation + help text. */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["text", "json", "stream-json"] as const

/**
 * Type guard: whether `value` is one of the three valid {@link OutputFormat}
 * strings. Used both by the resolver (to decide whether a `--output-format`
 * value participates in precedence) and by the entry point (to warn on a
 * malformed value before resolution swallows it).
 */
export function isOutputFormat(value: string | undefined): value is OutputFormat {
  return value === "text" || value === "json" || value === "stream-json"
}

/**
 * Resolve the effective {@link OutputFormat} from the CLI flags.
 *
 * `opts.outputFormatFlag` is the raw token that followed `--output-format` (or
 * `undefined` when absent); `opts.jsonFlag` is whether the legacy `--json`
 * boolean was present. A valid `--output-format` value wins outright: passing
 * both an explicit format and the `--json` alias resolves to the explicit
 * format. Otherwise `--json` maps to `json`. With neither, the format is
 * `text`. An unrecognized `--output-format` value is ignored and precedence
 * falls through to `--json` then `text`.
 */
export function resolveOutputFormat(opts: {
  outputFormatFlag: string | undefined
  jsonFlag: boolean
}): OutputFormat {
  if (isOutputFormat(opts.outputFormatFlag)) return opts.outputFormatFlag
  if (opts.jsonFlag) return "json"
  return "text"
}
