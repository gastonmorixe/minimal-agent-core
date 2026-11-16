/**
 * Built-in tool text contract (D-TOOLS option A).
 *
 * Core keeps the built-in tool code and the input schemas. A plugin that
 * provides `text.tools` supplies the description of each tool and the
 * description of each parameter. Core holds no such text.
 *
 * @module types/tool-text
 */

/** The text of one built-in tool. */
export interface BuiltinToolText {
  /** The tool description sent to the model. */
  readonly description: string
  /** Parameter name to parameter description. */
  readonly params: Readonly<Record<string, string>>
}

/** Supplies the text of the built-in tools it lists. */
export interface ToolTextProvider {
  /** The built-in tool names this provider owns. */
  readonly tools: readonly string[]
  /** Return the text of one tool, or undefined when it does not own it. */
  tool(name: string): BuiltinToolText | undefined
}
