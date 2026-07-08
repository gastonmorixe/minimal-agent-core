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
    content: "The content to write to the file",
  },
  Edit: {
    file_path: "The absolute path to the file to modify",
    old_string: "The text to replace",
    new_string: "The text to replace it with",
    replace_all: "Replace all occurrences (default false)",
  },
  Glob: {
    pattern: "The glob pattern to match files against",
    path: "Directory to search in. Defaults to cwd.",
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

export function toolAbortedByUserResult(): string {
  return "tool aborted by user"
}

export function unknownToolResult(name: string): string {
  return `Unknown tool: ${name}`
}

export function modeToolDispatcherBugResult(): string {
  return "Mode tool reached the dispatcher; this should have been handled by the agent loop. File a bug : see `agent.ts` Mode interceptor."
}

export function reflectionAckToolResult(): string {
  return "reflection-ack applied. Next time, write this tag as inline text in your response body, not as a tool call."
}

export function lockTimeoutResult(tool: string, message: string): string {
  return `${tool} error: ${message}`
}

export function lockAcquireFailedResult(tool: string, message: string): string {
  return `${tool} error: lock acquire failed: ${message}`
}

export function cdNoSuchDirectoryResult(path: string): string {
  return `cd: no such directory: ${path}`
}

export function bashOutputCapMarker(maxBytes: number): string {
  return `[output exceeded ${maxBytes} bytes; command terminated and output truncated]`
}

export function bashTimedOutMarker(timeoutMs: number): string {
  return `[timed out after ${timeoutMs}ms]`
}

export function bashExitCodeResult(exitCode: number | null): string {
  return `Exit code ${exitCode}`
}

export function bashErrorResult(message: string): string {
  return `Bash error: ${message}`
}

export function whitespaceResolvedNote(path: string): string {
  return `Note: resolved to "${path}" (whitespace mismatch).\n`
}

export function readTooLargeResult(sizeMb: string, limitMb: number): string {
  return `File is ${sizeMb} MB, exceeds the ${limitMb} MB read limit. Use offset/limit to read a portion, or Grep to search it.`
}

export function readErrorResult(message: string): string {
  return `Read error: ${message}`
}

export function fileWrittenResult(filePath: string): string {
  return `File written: ${filePath}`
}

export function writeErrorResult(message: string): string {
  return `Write error: ${message}`
}

export function editOldStringNotFoundResult(filePath: string): string {
  return `Edit error: old_string not found in ${filePath}`
}

export function editOldStringMultipleMatchesResult(count: number, filePath: string): string {
  return `Edit error: old_string matches ${count} locations in ${filePath}. Use replace_all or provide more context.`
}

export function fileEditedResult(filePath: string, replacements: number): string {
  return `File edited: ${filePath} (${replacements} replacement(s))`
}

export function editErrorResult(message: string): string {
  return `Edit error: ${message}`
}

export function noFilesMatchedResult(): string {
  return "No files matched the pattern."
}

export function globErrorResult(message: string): string {
  return `Glob error: ${message}`
}

export function grepErrorResult(message: string): string {
  return `Grep error: ${message}`
}

export function noMatchesFoundResult(): string {
  return "No matches found."
}

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
