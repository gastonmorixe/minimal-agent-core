/**
 * Built-in tool definitions: the JSON-schema surface the agent sends in the
 * `tools` array of each Messages API request.
 *
 * These are pure data (schemas + model-facing descriptions loaded from
 * markdown). Execution lives in `tools.ts`; keeping the definitions in their
 * own module keeps that file focused on the executor logic.
 *
 * @module tools/tool-definitions
 */

import { promptPath, renderPrompt } from "../prompts/prompts.ts"

import * as ToolPrompts from "./PROMPTS.ts"
import type { ToolDefinition } from "./tools.ts"

/**
 * Load a built-in tool's description from `src/prompts/tools/<name>.md`. Tool
 * descriptions are model-facing prompts, so they live in markdown rather than
 * inline string literals (see `src/prompts/README.md`).
 *
 * @param name - The markdown basename (e.g. `"bash"`).
 * @returns The rendered description text.
 */
function toolDescription(name: string): string {
  return renderPrompt(promptPath(import.meta, "..", "prompts", "tools", `${name}.md`))
}

const BASH_TOOL: ToolDefinition = {
  name: "Bash",
  icon: "»",
  color: "orange",
  description: toolDescription("bash"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      command: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Bash.command, type: "string" },
      timeout: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Bash.timeout, type: "number" },
      description: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Bash.description,
        type: "string",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
}

const READ_TOOL: ToolDefinition = {
  name: "Read",
  icon: "•",
  color: "sky",
  description: toolDescription("read"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Read.file_path,
        type: "string",
      },
      offset: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Read.offset,
        type: "integer",
        minimum: 0,
      },
      limit: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Read.limit,
        type: "integer",
        exclusiveMinimum: 0,
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
}

const WRITE_TOOL: ToolDefinition = {
  name: "Write",
  icon: "✚",
  color: "lime",
  description: toolDescription("write"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Write.file_path,
        type: "string",
      },
      content: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Write.content, type: "string" },
      contents: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Write.contents,
        type: "string",
      },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
}

const EDIT_TOOL: ToolDefinition = {
  name: "Edit",
  icon: "✦",
  color: "gold",
  description: toolDescription("edit"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      file_path: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Edit.file_path,
        type: "string",
      },
      old_string: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Edit.old_string,
        type: "string",
      },
      new_string: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Edit.new_string,
        type: "string",
      },
      replace_all: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Edit.replace_all,
        default: false,
        type: "boolean",
      },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
}

const GLOB_TOOL: ToolDefinition = {
  name: "Glob",
  icon: "✱",
  color: "violet",
  description: toolDescription("glob"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pattern: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Glob.pattern, type: "string" },
      glob_pattern: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Glob.glob_pattern,
        type: "string",
      },
      path: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Glob.path, type: "string" },
      target_directory: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Glob.target_directory,
        type: "string",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
}

const GREP_TOOL: ToolDefinition = {
  name: "Grep",
  icon: "⌕",
  color: "pink",
  description: toolDescription("grep"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pattern: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.pattern, type: "string" },
      path: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.path, type: "string" },
      glob: { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.glob, type: "string" },
      output_mode: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.output_mode,
        type: "string",
        enum: ["content", "files_with_matches", "count"],
      },
      "-i": {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.caseInsensitive,
        type: "boolean",
      },
      "-n": {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.showLineNumbers,
        type: "boolean",
      },
      "-A": { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.after, type: "number" },
      "-B": { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.before, type: "number" },
      "-C": { description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.context, type: "number" },
      context: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.contextAlias,
        type: "number",
      },
      head_limit: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.headLimit,
        type: "number",
      },
      multiline: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.Grep.multiline,
        type: "boolean",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
}

const FILES_STATS_TOOL: ToolDefinition = {
  name: "FilesStats",
  icon: "▦",
  color: "cyan",
  description: toolDescription("files-stats"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      status: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.FilesStats.status,
        type: "string",
        enum: ["all", "present", "missing", "changed"],
      },
      path: {
        description: ToolPrompts.TOOL_PARAM_DESCRIPTIONS.FilesStats.path,
        type: "string",
      },
    },
    additionalProperties: false,
  },
}

const MODE_TOOL: ToolDefinition = {
  name: "Mode",
  icon: "◐",
  color: "sky",
  description: toolDescription("mode"),
  input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {},
    additionalProperties: false,
  },
}

/**
 * All tool definitions, in the order the agent sends them in API requests.
 *
 * Pass this directly to `SendOptions.tools` or to the `Agent.run()` method to
 * enable tool use. The model will see these schemas and pick tools by name;
 * `executeTool` dispatches by the same names.
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
  FILES_STATS_TOOL,
  MODE_TOOL,
]
