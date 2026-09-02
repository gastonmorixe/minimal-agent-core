export const TOOL_PARAM_DESCRIPTIONS = {
  Bash: {
    command: "The command to execute",
    timeout: "Optional timeout in milliseconds (max 600000)",
    description: "Clear, concise description of what this command does",
  },
  Read: {
    file_path: "The absolute path to the file to read",
    offset: "Line number to start reading from",
    limit: "Number of lines to read",
  },
  Write: {
    file_path: "The absolute path to the file to write",
    content: "The content to write to the file. `contents` is accepted as an alias.",
    contents: "Alias for `content`. Same meaning; ignored when `content` is also set.",
  },
  Edit: {
    file_path: "The absolute path to the file to modify",
    old_string: "The text to replace",
    new_string: "The text to replace it with",
    replace_all: "Replace all occurrences (default false)",
  },
  Glob: {
    pattern: "The glob pattern to match files against. `glob_pattern` is accepted as an alias.",
    glob_pattern: "Alias for `pattern`. Same meaning; ignored when `pattern` is also set.",
    path: "Directory to search in. Defaults to cwd. `target_directory` is accepted as an alias.",
    target_directory: "Alias for `path`. Same meaning; ignored when `path` is also set.",
  },
  FilesStats: {
    status: "Optional status filter: all, present, missing, or changed",
    path: "Optional absolute path or directory prefix filter",
  },
  Grep: {
    pattern: "Regex pattern to search for",
    path: "File or directory to search in. Defaults to cwd.",
    glob: 'Glob pattern to filter files (e.g. "*.js")',
    output_mode: "Output mode: content, files_with_matches, or count",
    caseInsensitive: "Case insensitive search",
    showLineNumbers: "Show line numbers (default true)",
    after: "Lines after match",
    before: "Lines before match",
    context: "Context lines",
    contextAlias: "Context lines (alias for -C)",
    headLimit: "Limit output lines (default 250)",
    multiline: "Enable multiline mode",
  },
} as const

/** Returns the tool-result string shown when the user aborts a tool call. */
export function toolAbortedByUserResult(): string {
  return "tool aborted by user"
}

/** Returns the error string for an invocation of an unregistered tool name. */
export function unknownToolResult(name: string): string {
  return `Unknown tool: ${name}`
}

/** Returns the internal-bug message shown if the Mode tool reaches the dispatcher. */
export function modeToolDispatcherBugResult(): string {
  return "Mode tool reached the dispatcher; this should have been handled by the agent loop. File a bug : see `agent.ts` Mode interceptor."
}

/** Returns the note shown when a reflection-ack was submitted as a tool call. */
export function reflectionAckToolResult(): string {
  return "reflection-ack applied. Next time, write this tag as inline text in your response body, not as a tool call."
}

/** Returns the error string for a tool that timed out waiting on a file lock. */
export function lockTimeoutResult(tool: string, message: string): string {
  return `${tool} error: ${message}`
}

/** Returns the error string for a tool that failed to acquire a file lock. */
export function lockAcquireFailedResult(tool: string, message: string): string {
  return `${tool} error: lock acquire failed: ${message}`
}

/** Returns the shell-style error string for a cd into a nonexistent directory. */
export function cdNoSuchDirectoryResult(path: string): string {
  return `cd: no such directory: ${path}`
}

/** Returns the inline marker appended when Bash output exceeds the byte cap. */
export function bashOutputCapMarker(maxBytes: number): string {
  return `[output exceeded ${maxBytes} bytes; command terminated and output truncated]`
}

/** Returns the inline marker appended when a Bash command hits its timeout. */
export function bashTimedOutMarker(timeoutMs: number): string {
  return `[timed out after ${timeoutMs}ms]`
}

/** Returns the trailing line reporting a Bash command's exit code. */
export function bashExitCodeResult(exitCode: number | null): string {
  return `Exit code ${exitCode}`
}

/** Returns the error string for a failed Bash invocation. */
export function bashErrorResult(message: string): string {
  return `Bash error: ${message}`
}

/** Returns the note explaining an Edit target was resolved past a whitespace mismatch. */
export function whitespaceResolvedNote(path: string): string {
  return `Note: resolved to "${path}" (whitespace mismatch).\n`
}

/** Returns the error string for a Read of a file above the size limit. */
export function readTooLargeResult(sizeMb: string, limitMb: number): string {
  return `File is ${sizeMb} MB, exceeds the ${limitMb} MB read limit. Use offset/limit to read a portion, or Grep to search it.`
}

/** Returns the error string for a failed Read. */
export function readErrorResult(message: string): string {
  return `Read error: ${message}`
}

/** Returns the success string confirming a file was written. */
export function fileWrittenResult(filePath: string): string {
  return `File written: ${filePath}`
}

/** Returns the error string for a failed Write. */
export function writeErrorResult(message: string): string {
  return `Write error: ${message}`
}

/** Returns the error string when Write is called without file_path. */
export function writeMissingPathResult(): string {
  return "Write requires `file_path`."
}

/** Returns the error string when Write is called with neither content nor contents. */
export function writeMissingContentResult(): string {
  return "Write requires `content` (or alias `contents`)."
}

/**
 * Returns the error string when a Write string argument has the wrong type.
 *
 * @param key - The input field that was not a string (`file_path`, `content`, ...).
 * @param got - JSON-ish type name of the value that was sent.
 */
export function writeArgNotStringResult(key: string, got: string): string {
  return `Write \`${key}\` must be a string, got ${got}.`
}

/** Returns the Edit error string for an old_string not found in the file. */
export function editOldStringNotFoundResult(filePath: string): string {
  return `Edit error: old_string not found in ${filePath}`
}

/** Returns the Edit error string for an old_string matching multiple locations. */
export function editOldStringMultipleMatchesResult(count: number, filePath: string): string {
  return `Edit error: old_string matches ${count} locations in ${filePath}. Use replace_all or provide more context.`
}

/** Returns the success string confirming an Edit and its replacement count. */
export function fileEditedResult(filePath: string, replacements: number): string {
  return `File edited: ${filePath} (${replacements} replacement(s))`
}

/** Returns the error string for a failed Edit. */
export function editErrorResult(message: string): string {
  return `Edit error: ${message}`
}

/** Returns the Glob result string shown when no files match the pattern. */
export function noFilesMatchedResult(): string {
  return "No files matched the pattern."
}

/** Returns the error string when Glob is called with neither pattern nor glob_pattern. */
export function globMissingPatternResult(): string {
  return "Glob requires `pattern` (or alias `glob_pattern`)."
}

/**
 * Returns the error string when a Glob string argument has the wrong type.
 *
 * @param key - The input field that was not a string (`pattern`, `glob_pattern`, ...).
 * @param got - JSON-ish type name of the value that was sent.
 */
export function globArgNotStringResult(key: string, got: string): string {
  return `Glob \`${key}\` must be a string, got ${got}.`
}

/** Returns the error string for a failed Glob. */
export function globErrorResult(message: string): string {
  return `Glob error: ${message}`
}

/** Returns the error string for a failed Grep. */
export function grepErrorResult(message: string): string {
  return `Grep error: ${message}`
}

/** Returns the Grep result string shown when no matches are found. */
export function noMatchesFoundResult(): string {
  return "No matches found."
}

/** Returns tool content with an appended output-preview annotation describing how much was shown. */
export function outputPreviewAnnotation(args: {
  content: string
  shown: number
  total: number
  tool: string
  path?: string
  hint: string
}): string {
  const pathAttr = args.path ? ` path="${args.path}"` : ""
  return `${args.content}\n\n<ma::agent::output-preview shown="${args.shown}" total="${args.total}" tool="${args.tool}"${pathAttr}>${args.hint}</ma::agent::output-preview>`
}

/** Returns kept output plus a truncation notice reporting shown vs total bytes and lines. */
export function truncationNotice(args: {
  kept: string
  shownBytes: number
  totalBytes: string
  shownLines: number
  totalLines: string
  cutLine: number
  hint: string
}): string {
  return `${args.kept}\n\n[truncated: shown ${args.shownBytes} of ${args.totalBytes} bytes, ${args.shownLines}/${args.totalLines} lines; cut at byte ${args.shownBytes}, line ${args.cutLine}. ${args.hint}]`
}

/** Returns a per-tool hint on how to resume or narrow a call whose output was truncated. */
export function truncationHint(
  tool: string | undefined,
  cutLine: number,
  maxToolOutputBytes: number,
): string {
  switch (tool) {
    case "Read":
      return `to continue, call Read with offset=${cutLine} (and limit as needed).`
    case "Grep":
      return "narrow with a more specific pattern, glob, or smaller -A/-B/-C; or raise head_limit explicitly."
    case "Bash":
      return `output exceeded ${maxToolOutputBytes} bytes and the FRONT was kept, so trailing errors/build failures may be cut. Re-run scoped to the tail (e.g. \`... 2>&1 | tail -n 100\`) or filtered (\`grep -nE 'error:|FAIL'\`); or Read the tail of the raw-output blob whose path is appended below, which holds the full output.`
    case "Glob":
      return "narrow the pattern or search a subdirectory."
    case "Fetch":
      return "the full body is preserved at the `<ma::agent::raw-output ... />` path below; use Read on that path, or re-call Fetch with a CSS `selector` to scope to a specific element."
    case "WebSearch":
      return "lower `count`, narrow the query, or use the result's `url` to Fetch a specific page."
    default:
      return "re-run with narrower parameters; the full body is preserved at the `<ma::agent::raw-output ... />` path below."
  }
}

/** Returns the bracketed note warning that a tool has truncated several calls in a row. */
export function streakNote(tool: string, threshold: number): string {
  const body = streakNoteBody(tool, threshold)
  return `[note: ${body}]`
}

function streakNoteBody(tool: string, threshold: number): string {
  switch (tool) {
    case "Read":
      return `you've truncated ${threshold} Read calls in a row. Use the totals from the last [truncated: ...] notice to compute a single offset+limit that lands where you actually need to read, instead of paging from byte 0.`
    case "Grep":
      return `you've truncated ${threshold} Grep calls in a row. Try \`output_mode: "files_with_matches"\` (densest), tighten the pattern, add a \`glob\`/\`path\` filter, or set \`head_limit\` explicitly rather than letting the cap fire.`
    case "Bash":
      return `you've truncated ${threshold} Bash calls in a row. Bound output at the source: \`head -c\`, \`head -n\`, \`tail\`, \`sed -n '1,Np'\`, or pipe through a filter. The post-hoc cap is lossy; pre-bounding gives usable signal.`
    case "Glob":
      return `you've truncated ${threshold} Glob calls in a row. Narrow the pattern (e.g. add a subdirectory prefix or restrict the file extension) instead of matching the world.`
    default:
      return `you've truncated ${threshold} calls of this tool in a row. Re-think the parameters; see the [truncated: ...] notice on each prior call for resume hints.`
  }
}

/** Returns the hint shown when the TUI preview clipped tool output, noting where the full output lives. */
export function tuiPreviewHint(tool: string, rawPath?: string): string {
  const recover = rawPath
    ? ` The full untruncated output is saved at ${rawPath} : Read that path (its tail for build/test errors) when this preview isn't enough.`
    : ""
  switch (tool) {
    case "Bash":
      return `the user only saw a fraction of this output. If you used Bash to render visual content (ASCII art, ANSI TUI preview, formatted tables) for the user, put it in your text reply instead : the user reads that in full.${recover}`
    default:
      return `the user only saw a fraction of this output. If you intended this for the user, summarize the key parts in your text reply (the user reads it in full).${recover}`
  }
}
