/**
 * Public surface for the DeepSeek provider (OpenAI-Chat-compatible).
 *
 * @module llm/providers/deepseek
 */

export { bootstrapDeepSeek, deepseekAdapter, deepseekProviderPlugin } from "./adapter.ts"
export { CAPS_DEEPSEEK_CHAT } from "./capabilities.ts"
export { registerDeepSeekModels } from "./models.ts"
export { PRICING_DEEPSEEK_CHAT } from "./pricing.ts"
