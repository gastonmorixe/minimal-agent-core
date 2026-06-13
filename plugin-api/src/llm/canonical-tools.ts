/**
 * Canonical tool / function definitions plus the `ToolChoice` union.
 *
 * Tools are declared once in canonical form (a name, a description,
 * and a JSON-Schema input shape) and translated per-provider by the
 * adapter:
 *
 * - **Anthropic Messages**: `{name, description, input_schema}` for
 *   user-defined tools; `{type: "web_search_20250305"}` and friends
 *   for server-hosted tools.
 * - **OpenAI Chat Completions**:
 *   `{type: "function", function: {name, description, parameters, strict?}}`
 *   for user-defined; server tools live elsewhere (most are Responses-only).
 * - **OpenAI Responses**: flat
 *   `{type: "function", name, description, parameters, strict?}`
 *   (no nested `function` wrapper); server tools
 *   `{type: "web_search_preview"}`, `{type: "file_search"}`, etc.
 *
 * @module llm/canonical-tools
 */

import type { ServerToolId } from "./capabilities.ts"

// ---------------------------------------------------------------------------
// JSON Schema (loose type)
// ---------------------------------------------------------------------------

/**
 * JSON-Schema 2020-12 fragment used for tool input shape declarations.
 * Kept loose : we don't validate at this layer, we hand the schema to
 * the provider and let them validate (or not).
 */
export type JSONSchema = Record<string, unknown>

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * One callable tool the model can invoke.
 *
 * - `name`: stable identifier. Matches `ToolUseBlock.name` and
 *   `ToolResultBlock.toolUseId` pairings.
 * - `description`: human-language usage hint for the model. This is
 *   the single biggest lever for tool-selection quality : be precise.
 * - `inputSchema`: JSON Schema describing the input object.
 * - `strict`: if true, ask the provider to validate inputs against the
 *   schema server-side (OpenAI honors this; Anthropic does not).
 *   Pre-validating client-side is the adapter's choice.
 * - `server`: when set, this declares a provider-hosted tool. The
 *   adapter is responsible for wire-shape translation; the agent never
 *   "executes" this tool itself.
 */
export interface CanonicalToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
  strict?: boolean
  server?: ServerToolId
}

// ---------------------------------------------------------------------------
// Tool choice
// ---------------------------------------------------------------------------

/**
 * Tool-selection policy for a single request.
 *
 * - `auto`: model decides whether to call a tool. Default.
 * - `none`: tools are visible but must not be called. Useful for one-shot
 *   prose turns inside a tool-heavy loop.
 * - `any`: model MUST call some tool (any tool). OpenAI "required".
 * - `tool`: model MUST call the specified tool.
 */
export type ToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "any" }
  | { type: "tool"; name: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cheap "is this a server-hosted tool" check, used by adapters when
 * splitting user tools from server tools at wire-shape time.
 */
export function isServerTool(tool: CanonicalToolDefinition): boolean {
  return tool.server !== undefined
}
