/**
 * Minimal shell-style argument tokenizer shared by the host and core.
 *
 * Splits a command string into an argv array, honoring single- and
 * double-quoted segments (quotes are stripped, their contents kept intact
 * including embedded whitespace). Everything else splits on runs of
 * whitespace. There is no escape/`\`-processing, no variable expansion, and
 * no operator handling: it is a display/config convenience, not a shell.
 *
 * Pure and dependency-free: no host imports, no env reads. Lives in the leaf
 * `@minimal-agent/plugin-api` package so the host formatter, the CLI entry,
 * and core config all tokenize identically.
 *
 * @module shell-args
 */

/**
 * Tokenize a shell-style command string into an argv array.
 *
 * @example
 * parseFormatterCommand("mdstream")                    // ["mdstream"]
 * parseFormatterCommand("bat --paging=never")          // ["bat", "--paging=never"]
 * parseFormatterCommand("/path/fmt --title 'My Doc'")  // ["/path/fmt", "--title", "My Doc"]
 */
export function parseFormatterCommand(cmd: string): string[] {
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(cmd)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3])
  }
  return args
}
