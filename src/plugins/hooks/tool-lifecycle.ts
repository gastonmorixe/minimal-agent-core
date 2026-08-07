/**
 * Compatibility facade for the tool-lifecycle hook contract.
 *
 * The SDK owns the canonical lifecycle vocabulary. Plugin and host code may
 * continue importing this legacy path without creating a second declaration.
 *
 * @module plugins/hooks/tool-lifecycle
 */

export {
  addFinding,
  addNote,
  type Finding,
  type FindingSeverity,
  makeToolDidInvokePayload,
  type ToolDidInvokePayload,
  type ToolDidInvokeSeed,
} from "../../sdk/tool-lifecycle.ts"
