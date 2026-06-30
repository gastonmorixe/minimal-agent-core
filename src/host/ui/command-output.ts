/**
 * Output plumbing for one-shot CLI command renderers.
 *
 * Command modules should build rows, then hand writing to this UI helper so
 * tests can inject collectors and command logic does not call `console.*`.
 *
 * @module ui/command-output
 */

export interface CommandOutput {
  write(s: string): unknown
}

/** Write rendered rows with exactly one trailing newline. */
export function writeCommandRows(
  rows: readonly string[],
  output: CommandOutput = process.stdout,
): void {
  output.write(`${rows.join("\n")}\n`)
}
