/**
 * Tools module: tool definitions and execution for the minimal agent.
 *
 * Implements a subset of the tools the real Claude Code CLI provides. Each
 * tool has a JSON-schema definition (sent to the API) and a local executor
 * function. The agent's tool loop calls {@link executeTool} when the model
 * emits a `tool_use` block, then sends the result back as a `tool_result`.
 *
 * **Tools provided:**
 * - {@link BASH_TOOL Bash}: execute shell commands (cwd persists across calls)
 * - {@link READ_TOOL Read}: read file contents with cat -n style line numbers
 * - {@link WRITE_TOOL Write}: write/create files (creates parent dirs)
 * - {@link EDIT_TOOL Edit}: exact string replacement in files
 * - {@link GLOB_TOOL Glob}: find files by glob pattern (uses bash globstar)
 * - {@link GREP_TOOL Grep}: search file contents using ripgrep
 *
 * **Skipped intentionally** (not implemented in minimal agent):
 * - Agent (sub-agent spawning)
 * - Skill (slash-command-style skill execution)
 * - ToolSearch (deferred tool loading)
 *
 * Tool schemas match the exact JSON schemas extracted from the v2.1.91 capture
 * at `.node-net-dbg/.../fetch-014-02-req-body.txt`. The agent sends them
 * unmodified so the model sees the same surface as the real CLI.
 *
 * @module tools
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A tool definition sent in the `tools` array of a Messages API request.
 *
 * The Anthropic API uses this exact shape (see SDK type `Anthropic.Tool`).
 * The `input_schema` field is a JSON Schema that the model uses to construct
 * valid tool inputs.
 *
 * @example
 * ```ts
 * const myTool: ToolDefinition = {
 *   name: "Calculator",
 *   description: "Performs basic arithmetic",
 *   input_schema: {
 *     type: "object",
 *     properties: { expression: { type: "string" } },
 *     required: ["expression"],
 *   },
 * };
 * ```
 */
export interface ToolDefinition {
  /** Unique tool name. Must match the `name` in `tool_use` blocks. */
  name: string;
  /** Plain-text description shown to the model — explains when/how to use it. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  input_schema: Record<string, unknown>;
}

/**
 * Result of executing a tool locally. Sent back to the API as the `content`
 * of a `tool_result` block.
 *
 * @example
 * ```ts
 * // Success:
 * { content: "file contents here..." }
 *
 * // Error:
 * { content: "Read error: ENOENT", is_error: true }
 * ```
 */
export interface ToolExecResult {
  /** Tool output as a string (multi-line allowed). */
  content: string;
  /** True if the tool failed; the model uses this to decide whether to retry. */
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Tool definitions (matching v2.1.91 capture schemas)
// ---------------------------------------------------------------------------

const BASH_TOOL: ToolDefinition = {
  name: "Bash",
  description: "Executes a given bash command and returns its output.\n\nThe working directory persists between commands, but shell state does not.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      command: { description: "The command to execute", type: "string" },
      timeout: { description: "Optional timeout in milliseconds (max 600000)", type: "number" },
      description: { description: "Clear, concise description of what this command does", type: "string" },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const READ_TOOL: ToolDefinition = {
  name: "Read",
  description: "Reads a file from the local filesystem. Returns content with line numbers.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: { description: "The absolute path to the file to read", type: "string" },
      offset: { description: "Line number to start reading from", type: "integer", minimum: 0 },
      limit: { description: "Number of lines to read", type: "integer", exclusiveMinimum: 0 },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
};

const WRITE_TOOL: ToolDefinition = {
  name: "Write",
  description: "Writes a file to the local filesystem. Overwrites existing files.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: { description: "The absolute path to the file to write", type: "string" },
      content: { description: "The content to write to the file", type: "string" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
};

const EDIT_TOOL: ToolDefinition = {
  name: "Edit",
  description: "Performs exact string replacements in files.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: { description: "The absolute path to the file to modify", type: "string" },
      old_string: { description: "The text to replace", type: "string" },
      new_string: { description: "The text to replace it with", type: "string" },
      replace_all: { description: "Replace all occurrences (default false)", default: false, type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
};

const GLOB_TOOL: ToolDefinition = {
  name: "Glob",
  description: "Fast file pattern matching. Returns matching file paths sorted by modification time.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pattern: { description: "The glob pattern to match files against", type: "string" },
      path: { description: "Directory to search in. Defaults to cwd.", type: "string" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

const GREP_TOOL: ToolDefinition = {
  name: "Grep",
  description: "Search file contents with regex using ripgrep.",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pattern: { description: "Regex pattern to search for", type: "string" },
      path: { description: "File or directory to search in. Defaults to cwd.", type: "string" },
      glob: { description: "Glob pattern to filter files (e.g. \"*.js\")", type: "string" },
      output_mode: {
        description: "Output mode: content, files_with_matches, or count",
        type: "string",
        enum: ["content", "files_with_matches", "count"],
      },
      "-i": { description: "Case insensitive search", type: "boolean" },
      "-n": { description: "Show line numbers (default true)", type: "boolean" },
      "-A": { description: "Lines after match", type: "number" },
      "-B": { description: "Lines before match", type: "number" },
      "-C": { description: "Context lines", type: "number" },
      context: { description: "Context lines (alias for -C)", type: "number" },
      head_limit: { description: "Limit output lines (default 250)", type: "number" },
      multiline: { description: "Enable multiline mode", type: "boolean" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
};

/**
 * All tool definitions, in the order the agent sends them in API requests.
 *
 * Pass this directly to {@link SendOptions.tools} or to the `Agent.run()`
 * method to enable tool use. The model will see these schemas and pick
 * tools by name; {@link executeTool} dispatches by the same names.
 *
 * @example
 * ```ts
 * import { TOOL_DEFINITIONS, executeTool } from "./tools.ts";
 *
 * const response = await sendMessageFull({
 *   auth, messages,
 *   tools: TOOL_DEFINITIONS,
 * });
 *
 * for (const block of response.blocks) {
 *   if (block.type === "tool_use") {
 *     const result = executeTool(block.name, block.input);
 *     // send result back as tool_result block...
 *   }
 * }
 * ```
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  BASH_TOOL,
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * Working directory for Bash, persists across calls within a single agent
 * process. Mirrors the real CLI's behavior where `cd` in one Bash call
 * affects subsequent calls (but shell state like env vars and aliases does not).
 */
let bashCwd = process.cwd();

/**
 * Execute a tool by name with the given input.
 *
 * Dispatches to the appropriate exec function. Unknown tool names return an
 * error result rather than throwing — the model can recover by picking a
 * different tool.
 *
 * @param name - Tool name as it appears in {@link ToolDefinition.name}
 * @param input - Parsed JSON input matching the tool's `input_schema`
 * @returns Tool result with `content` and optional `is_error` flag
 *
 * @example
 * ```ts
 * const result = executeTool("Bash", { command: "echo hello" });
 * console.log(result.content); // "hello"
 * ```
 */
export function executeTool(
  name: string,
  input: Record<string, unknown>,
): ToolExecResult {
  switch (name) {
    case "Bash":
      return execBash(input);
    case "Read":
      return execRead(input);
    case "Write":
      return execWrite(input);
    case "Edit":
      return execEdit(input);
    case "Glob":
      return execGlob(input);
    case "Grep":
      return execGrep(input);
    default:
      return { content: `Unknown tool: ${name}`, is_error: true };
  }
}

/**
 * Execute a Bash command via `bash -c`.
 *
 * Special handling for `cd` commands: rather than forking a shell that
 * immediately exits (losing the cwd change), we parse `cd <path>` ourselves
 * and update the persistent {@link bashCwd}.
 *
 * Stdout and stderr are concatenated into the result content. Non-zero exit
 * codes are reported as errors.
 *
 * @param input.command - Shell command to execute
 * @param input.timeout - Optional timeout in ms (default: 120000)
 */
function execBash(input: Record<string, unknown>): ToolExecResult {
  const command = input.command as string;
  const timeout = (input.timeout as number) ?? 120_000;

  try {
    // Handle cd commands by tracking cwd
    const cdMatch = command.match(/^cd\s+(.+)$/);
    if (cdMatch) {
      const { resolve } = require("node:path");
      const newDir = resolve(bashCwd, cdMatch[1].replace(/^["']|["']$/g, ""));
      if (existsSync(newDir)) {
        bashCwd = newDir;
        return { content: "" };
      }
      return { content: `cd: no such directory: ${cdMatch[1]}`, is_error: true };
    }

    const result = spawnSync("bash", ["-c", command], {
      cwd: bashCwd,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      env: { ...process.env, TERM: "dumb" },
    });

    const output = [result.stdout ?? "", result.stderr ?? ""]
      .filter(Boolean)
      .join("\n")
      .trim();

    if (result.status !== 0) {
      return {
        content: output || `Exit code ${result.status}`,
        is_error: true,
      };
    }
    return { content: output };
  } catch (e) {
    return {
      content: `Bash error: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
    };
  }
}

/**
 * Read a file with cat -n style line numbers.
 *
 * Output format: `<line_number>\t<line_content>` per line. Matches the format
 * the model expects from the real CLI's Read tool, so it can reference line
 * numbers in subsequent Edit calls.
 *
 * @param input.file_path - Absolute path to read
 * @param input.offset - Zero-based line offset to start at (default: 0)
 * @param input.limit - Max number of lines to read (default: all)
 */
function execRead(input: Record<string, unknown>): ToolExecResult {
  const filePath = input.file_path as string;
  const offset = (input.offset as number) ?? 0;
  const limit = input.limit as number | undefined;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = offset;
    const end = limit ? start + limit : lines.length;
    const slice = lines.slice(start, end);

    // Return with line numbers (cat -n style)
    const numbered = slice
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n");
    return { content: numbered };
  } catch (e) {
    return {
      content: `Read error: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
    };
  }
}

/**
 * Write content to a file, overwriting any existing content. Creates parent
 * directories as needed (matching the real CLI's Write tool behavior).
 *
 * @param input.file_path - Absolute path to write
 * @param input.content - Full file content
 */
function execWrite(input: Record<string, unknown>): ToolExecResult {
  const filePath = input.file_path as string;
  const content = input.content as string;

  try {
    // Ensure parent directory exists
    const { dirname } = require("node:path");
    const { mkdirSync } = require("node:fs");
    mkdirSync(dirname(filePath), { recursive: true });

    writeFileSync(filePath, content);
    return { content: `File written: ${filePath}` };
  } catch (e) {
    return {
      content: `Write error: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
    };
  }
}

/**
 * Replace exact text in a file.
 *
 * **Uniqueness check**: if `replace_all` is false, the `old_string` must
 * match exactly once. Multiple matches return an error so the model is
 * forced to provide more context (matching the real CLI's safety behavior).
 *
 * @param input.file_path - Absolute path to modify
 * @param input.old_string - Exact text to find
 * @param input.new_string - Replacement text
 * @param input.replace_all - If true, replace all matches (default: false)
 */
function execEdit(input: Record<string, unknown>): ToolExecResult {
  const filePath = input.file_path as string;
  const oldString = input.old_string as string;
  const newString = input.new_string as string;
  const replaceAll = (input.replace_all as boolean) ?? false;

  try {
    let content = readFileSync(filePath, "utf-8");
    const count = content.split(oldString).length - 1;

    if (count === 0) {
      return {
        content: `Edit error: old_string not found in ${filePath}`,
        is_error: true,
      };
    }

    if (!replaceAll && count > 1) {
      return {
        content: `Edit error: old_string matches ${count} locations in ${filePath}. Use replace_all or provide more context.`,
        is_error: true,
      };
    }

    if (replaceAll) {
      content = content.split(oldString).join(newString);
    } else {
      content = content.replace(oldString, newString);
    }

    writeFileSync(filePath, content);
    return { content: `File edited: ${filePath} (${replaceAll ? count : 1} replacement(s))` };
  } catch (e) {
    return {
      content: `Edit error: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
    };
  }
}

/**
 * Find files matching a glob pattern using bash globstar (`**`).
 *
 * Output is limited to 100 entries to avoid context bloat. Patterns like
 * `**\/*.ts` (recursive) and `*.json` (single-level) both work.
 *
 * @param input.pattern - Glob pattern (e.g. `**\/*.ts`, `src/*.{js,ts}`)
 * @param input.path - Directory to search in (default: current bash cwd)
 */
function execGlob(input: Record<string, unknown>): ToolExecResult {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? bashCwd;

  try {
    // Use find or fd if available, fallback to shell glob
    const result = spawnSync("bash", ["-c", `shopt -s globstar nullglob; cd "${searchPath}" && ls -1d ${pattern} 2>/dev/null | head -100`], {
      cwd: searchPath,
      timeout: 10_000,
      encoding: "utf-8",
    });

    const output = (result.stdout ?? "").trim();
    if (!output) {
      return { content: "No files matched the pattern." };
    }
    return { content: output };
  } catch (e) {
    return {
      content: `Glob error: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
    };
  }
}

/**
 * Search file contents using ripgrep (`rg`).
 *
 * Three output modes (matches the real CLI's Grep tool):
 * - `files_with_matches` (default): list paths only
 * - `count`: count matches per file
 * - `content`: show matching lines with optional context (-A/-B/-C)
 *
 * Results are head-limited (default 250 lines) with a "... N more lines"
 * marker to keep responses bounded. Pass `head_limit: 0` for unlimited.
 *
 * @param input.pattern - Regex pattern to search for
 * @param input.path - File or directory to search (default: bash cwd)
 * @param input.glob - Glob filter (e.g. `*.ts`)
 * @param input.output_mode - `content` | `files_with_matches` | `count`
 * @param input["-i"] - Case insensitive
 * @param input["-A"] - Lines after match (content mode only)
 * @param input["-B"] - Lines before match (content mode only)
 * @param input["-C"] - Context lines (content mode only)
 * @param input.head_limit - Cap output lines (default: 250, 0 = unlimited)
 * @param input.multiline - Allow `.` to match newlines
 */
function execGrep(input: Record<string, unknown>): ToolExecResult {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? bashCwd;
  const outputMode = (input.output_mode as string) ?? "files_with_matches";
  const caseInsensitive = input["-i"] as boolean;
  const headLimit = (input.head_limit as number) ?? 250;
  const glob = input.glob as string | undefined;
  const contextA = input["-A"] as number | undefined;
  const contextB = input["-B"] as number | undefined;
  const contextC = (input["-C"] ?? input.context) as number | undefined;
  const multiline = input.multiline as boolean;

  const args = ["--no-heading", "--color=never"];

  if (outputMode === "files_with_matches") args.push("-l");
  else if (outputMode === "count") args.push("-c");
  else args.push("-n"); // content mode, show line numbers

  if (caseInsensitive) args.push("-i");
  if (multiline) args.push("-U", "--multiline-dotall");
  if (glob) args.push("--glob", glob);
  if (contextA != null) args.push("-A", String(contextA));
  if (contextB != null) args.push("-B", String(contextB));
  if (contextC != null) args.push("-C", String(contextC));

  args.push(pattern, searchPath);

  try {
    const result = spawnSync("rg", args, {
      timeout: 30_000,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
    });

    let output = (result.stdout ?? "").trim();
    if (headLimit > 0) {
      const lines = output.split("\n");
      if (lines.length > headLimit) {
        output = lines.slice(0, headLimit).join("\n") + `\n... (${lines.length - headLimit} more lines)`;
      }
    }

    if (!output) {
      return { content: "No matches found." };
    }
    return { content: output };
  } catch (e) {
    return {
      content: `Grep error: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
    };
  }
}
