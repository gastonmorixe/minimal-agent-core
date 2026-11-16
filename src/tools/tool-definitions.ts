/**
 * Built-in tool definitions: the JSON-schema surface the agent sends in the
 * `tools` array of each Messages API request.
 *
 * {@link TOOL_SPECS} holds the schemas only (name + input_schema, no
 * description keys). {@link buildToolDefinitions} adds the model-facing text:
 * from a `text.tools` provider when one owns the tool, else today's core text
 * (markdown descriptions + `TOOL_PARAM_DESCRIPTIONS`). The key order matches
 * the old literal definitions, so `JSON.stringify` of the result is byte-equal.
 * Execution lives in `tools.ts`.
 *
 * @module tools/tool-definitions
 */

import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import { promptPath, renderPrompt } from "../prompts/prompts.ts"

import type { ToolDefinition } from "./tools.ts"

/** One built-in tool schema with no model-facing text. */
export interface ToolSpec {
  readonly name: string
  readonly input_schema: Record<string, unknown>
}

/**
 * Load a built-in tool's description from `src/prompts/tools/<name>.md`
 * (the fallback text when no provider owns the tool).
 */
function toolDescription(name: string): string {
  return renderPrompt(promptPath(import.meta, "..", "prompts", "tools", `${name}.md`))
}

const BASH_TOOL: ToolSpec = {
  name: "Bash",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number" },
      description: {
        type: "string",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
}

const READ_TOOL: ToolSpec = {
  name: "Read",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: {
        type: "string",
      },
      offset: {
        type: "integer",
        minimum: 0,
      },
      limit: {
        type: "integer",
        exclusiveMinimum: 0,
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
}

const WRITE_TOOL: ToolSpec = {
  name: "Write",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: {
        type: "string",
      },
      content: { type: "string" },
      contents: {
        type: "string",
      },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
}

const EDIT_TOOL: ToolSpec = {
  name: "Edit",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: {
        type: "string",
      },
      old_string: {
        type: "string",
      },
      new_string: {
        type: "string",
      },
      replace_all: {
        default: false,
        type: "boolean",
      },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
}

const GLOB_TOOL: ToolSpec = {
  name: "Glob",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pattern: { type: "string" },
      glob_pattern: {
        type: "string",
      },
      path: { type: "string" },
      target_directory: {
        type: "string",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
}

const GREP_TOOL: ToolSpec = {
  name: "Grep",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
      },
      "-i": {
        type: "boolean",
      },
      "-n": {
        type: "boolean",
      },
      "-A": { type: "number" },
      "-B": { type: "number" },
      "-C": { type: "number" },
      context: {
        type: "number",
      },
      head_limit: {
        type: "number",
      },
      multiline: {
        type: "boolean",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
}

const FILES_STATS_TOOL: ToolSpec = {
  name: "FilesStats",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["all", "present", "missing", "changed"],
      },
      path: {
        type: "string",
      },
    },
    additionalProperties: false,
  },
}

const MODE_TOOL: ToolSpec = {
  name: "Mode",
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
    additionalProperties: false,
  },
}

/** All built-in tool schemas, in the order the agent sends them. */
export const TOOL_SPECS: readonly ToolSpec[] = [
  BASH_TOOL,
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  FILES_STATS_TOOL,
  MODE_TOOL,
]

/** The built-in tool names, in request order (data). */
export const BUILTIN_TOOL_NAMES: readonly string[] = TOOL_SPECS.map((t) => t.name)

/** Fallback description markdown basename per tool. */
const FALLBACK_DESCRIPTION_FILE: Readonly<Record<string, string>> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  FilesStats: "files-stats",
  Mode: "mode",
}

/** Fallback tool parameter text (moves out of core in P3.4). */
const TOOL_PARAM_DESCRIPTIONS = {
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

const P = TOOL_PARAM_DESCRIPTIONS

/** Fallback param text per tool, keyed by the schema property name. */
const FALLBACK_PARAMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Bash: P.Bash,
  Read: P.Read,
  Write: P.Write,
  Edit: P.Edit,
  Glob: P.Glob,
  FilesStats: P.FilesStats,
  Grep: {
    pattern: P.Grep.pattern,
    path: P.Grep.path,
    glob: P.Grep.glob,
    output_mode: P.Grep.output_mode,
    "-i": P.Grep.caseInsensitive,
    "-n": P.Grep.showLineNumbers,
    "-A": P.Grep.after,
    "-B": P.Grep.before,
    "-C": P.Grep.context,
    context: P.Grep.contextAlias,
    head_limit: P.Grep.headLimit,
    multiline: P.Grep.multiline,
  },
  Mode: {},
}

/** Fallback description cache: the markdown is read once per tool. */
const fallbackDescriptions = new Map<string, string>()

function fallbackDescription(name: string): string | undefined {
  const file = FALLBACK_DESCRIPTION_FILE[name]
  if (file === undefined) return undefined
  let text = fallbackDescriptions.get(name)
  if (text === undefined) {
    text = toolDescription(file)
    fallbackDescriptions.set(name, text)
  }
  return text
}

/** The first provider that returns text for `name` wins. A throw counts as no text. */
function providerText(
  providers: readonly ToolTextProvider[],
  name: string,
): { description?: unknown; params?: unknown } | undefined {
  for (const p of providers) {
    let t: unknown
    try {
      t = p.tool(name)
    } catch {
      t = undefined
    }
    if (t && typeof t === "object") return t as { description?: unknown; params?: unknown }
  }
  return undefined
}

function withParamText(
  schema: Record<string, unknown>,
  params: Record<string, unknown> | undefined,
  fallback: Readonly<Record<string, string>> | undefined,
): Record<string, unknown> {
  const props = schema.properties
  if (!props || typeof props !== "object") return schema
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(props as Record<string, Record<string, unknown>>)) {
    const fromProvider = params?.[key]
    const text = typeof fromProvider === "string" ? fromProvider : fallback?.[key]
    // `description` goes first, at the same key position as the old literals.
    out[key] = text === undefined ? { ...prop } : { description: text, ...prop }
  }
  return { ...schema, properties: out }
}

/**
 * Build the built-in tool definitions with their model-facing text. A tool
 * or param that no provider covers keeps today's core text. `description`
 * sits right after `name`, and each param `description` is the first key of
 * its property, so `JSON.stringify` matches the old literal definitions.
 * Pure: call it once per boot (or per core), not per request.
 */
export function buildToolDefinitions(
  providers: readonly ToolTextProvider[] = [],
): ToolDefinition[] {
  return TOOL_SPECS.map((spec) => {
    const own = providerText(providers, spec.name)
    const description =
      typeof own?.description === "string" ? own.description : fallbackDescription(spec.name)
    const params =
      own?.params && typeof own.params === "object"
        ? (own.params as Record<string, unknown>)
        : undefined
    const input_schema = withParamText(spec.input_schema, params, FALLBACK_PARAMS[spec.name])
    // M8: no text at all omits the `description` key (wire type only).
    return (
      description === undefined
        ? { name: spec.name, input_schema }
        : { name: spec.name, description, input_schema }
    ) as ToolDefinition
  })
}

/**
 * All tool definitions with today's core text, in request order. Kept for
 * existing callers until P3 removes it. New code uses
 * {@link buildToolDefinitions} with the loader's tool text providers.
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = buildToolDefinitions()
