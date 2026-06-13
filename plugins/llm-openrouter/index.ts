/**
 * Public surface for the OpenRouter provider (OpenAI-compatible gateway).
 *
 * @module llm/providers/openrouter
 */

export { bootstrapOpenRouter, openrouterAdapter, openrouterProviderPlugin } from "./adapter.ts"
export {
  buildOpenRouterApiKeyCredential,
  OPENROUTER_API_KEY_AUTH,
  openRouterApiKeyAuth,
  openRouterApiKeyToSecrets,
  readOpenRouterApiKey,
} from "./auth.ts"
export { CAPS_OPENROUTER_CHAT } from "./capabilities.ts"
export { registerOpenRouterModels } from "./models.ts"
export { PRICING_OR_CLAUDE_35_SONNET, PRICING_OR_GPT_4O_MINI } from "./pricing.ts"
