/**
 * Re-export shim — the Anthropic capability validator moved to the leaf
 * contract package `@minimal-agent/plugin-api`.
 *
 * The implementation now lives at `plugin-api/src/llm/anthropic-request.ts` so
 * an Anthropic-compatible gateway (e.g. opencode) can vendor the SAME
 * validator from the leaf instead of cross-importing this plugin. This shim
 * keeps the old in-plugin path working for the anthropic adapter + tests until
 * the plugin itself is migrated.
 *
 * @module llm/providers/anthropic/validate
 */

export { validateAnthropicRequest } from "@minimal-agent/plugin-api/llm/anthropic-request"
