/**
 * Re-export shim — the Anthropic SSE→CanonicalEvent translator moved to the
 * leaf contract package `@minimal-agent/plugin-api`.
 *
 * The implementation now lives at `plugin-api/src/llm/anthropic-stream.ts` so
 * a gateway provider (e.g. opencode) can vendor the SAME translator from the
 * leaf instead of cross-importing this plugin. This shim keeps the old
 * in-plugin path working for the anthropic adapter + tests until the plugin
 * itself is migrated.
 *
 * @module llm/providers/anthropic/response-stream
 */

export {
  type AnthropicStreamEvent,
  translateAnthropicStream,
} from "@minimal-agent/plugin-api/llm/anthropic-stream"
