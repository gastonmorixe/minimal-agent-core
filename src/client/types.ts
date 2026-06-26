/**
 * Back-compat re-export shim for the agent loop's transport vocabulary.
 *
 * The conversation types (`Message`, `ContentBlock`, the block interfaces)
 * now live in the provider-neutral `src/llm/messages.ts`; the transport
 * option/response types (`SendOptions`, `StreamedResponse`, `StreamEvent`,
 * `ModelInfo`) and the context-alias helpers (`normalizeModelForAPI`,
 * `has1mContext`) live in `src/llm/transport/types.ts`. This module re-exports
 * both so existing importers reaching these through the `client.ts` barrel
 * keep resolving while the legacy transport is dissolved. New code: import
 * from those neutral modules directly.
 *
 * @module client/types
 */

export type {
  BlockCacheControl,
  ContentBlock,
  DocumentBlock,
  ImageBlock,
  Message,
  RedactedThinkingBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../llm/messages.ts"
export type {
  ModelInfo,
  SendOptions,
  StreamEvent,
  StreamedResponse,
} from "../llm/transport/types.ts"
export { has1mContext, normalizeModelForAPI } from "../llm/transport/types.ts"
