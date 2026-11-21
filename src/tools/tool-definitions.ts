/**
 * Built-in tool definitions: the JSON-schema surface the agent sends in the
 * `tools` array of each Messages API request.
 *
 * {@link TOOL_SPECS} holds the schemas only (name + input_schema, no
 * description keys). {@link buildToolDefinitions} adds the model-facing text:
 * from the `text.tools` providers only (core holds no tool text). The key order matches
 * the old literal definitions, so `JSON.stringify` of the result is byte-equal.
 * Execution lives in `tools.ts`.
 *
 * @module tools/tool-definitions
 */

import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import type { PromptExpander } from "../plugins/prompt-expand.ts"

import type { ToolDefinition } from "./tools.ts"

/** One built-in tool schema with no model-facing text. */
export interface ToolSpec {
  readonly name: string
  readonly input_schema: Record<string, unknown>
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
  render: (text: string) => string,
): Record<string, unknown> {
  const props = schema.properties
  if (!props || typeof props !== "object") return schema
  const out: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(props as Record<string, Record<string, unknown>>)) {
    const text = params?.[key]
    // `description` goes first, at the same key position as the old literals.
    out[key] = typeof text === "string" ? { description: render(text), ...prop } : { ...prop }
  }
  return { ...schema, properties: out }
}

/**
 * Build the built-in tool definitions with their model-facing text from the
 * `text.tools` providers. Core holds no tool text: a tool or param that no
 * provider covers has no `description` key (M8). `description` sits right
 * after `name`, and each param `description` is the first key of its
 * property, so `JSON.stringify` matches the old literal definitions.
 * Pure: call it once per boot (or per core), not per request.
 *
 * `expand` (S5, design 50 §2): the provider text is static prompt text, so
 * core renders the description and each param text with it. The host and
 * the startup hash pass the same expander, so the hash sees the same bytes.
 */
export function buildToolDefinitions(
  providers: readonly ToolTextProvider[] = [],
  expand?: PromptExpander,
): ToolDefinition[] {
  return TOOL_SPECS.map((spec) => {
    const own = providerText(providers, spec.name)
    const source = `tool:${spec.name}`
    const render = (text: string): string =>
      expand === undefined || text === "" ? text : expand(text, { source })
    const description = typeof own?.description === "string" ? render(own.description) : undefined
    const params =
      own?.params && typeof own.params === "object"
        ? (own.params as Record<string, unknown>)
        : undefined
    const input_schema = withParamText(spec.input_schema, params, render)
    // M8: no text at all omits the `description` key (wire type only).
    return (
      description === undefined
        ? { name: spec.name, input_schema }
        : { name: spec.name, description, input_schema }
    ) as ToolDefinition
  })
}
