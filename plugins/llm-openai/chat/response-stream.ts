/**
 * Re-export shim — the OpenAI Chat Completions SSE→CanonicalEvent translator
 * moved to the leaf contract package `@minimal-agent/plugin-api`.
 *
 * The implementation now lives at `plugin-api/src/llm/openai-chat.ts` so every
 * OpenAI-compatible gateway provider (openrouter, opencode, huggingface,
 * wafer) can vendor the SAME translator from the leaf instead of
 * cross-importing this plugin. This shim keeps the old in-plugin path working
 * for the openai adapter + tests until the plugin itself is migrated.
 *
 * @module llm/providers/openai/chat/response-stream
 */

export {
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "@minimal-agent/plugin-api/llm/openai-chat"
