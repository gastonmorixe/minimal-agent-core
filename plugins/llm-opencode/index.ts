/**
 * Public surface for the OpenCode Go provider (dual-surface: OpenAI Chat +
 * Anthropic Messages).
 *
 * @module llm/providers/opencode
 */

export { bootstrapOpencode, opencodeAdapter, opencodeProviderPlugin } from "./adapter.ts"
export {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  opencodeApiKeyToSecrets,
  readOpencodeApiKey,
} from "./auth.ts"
export {
  CAPS_OPENCODE_CHAT,
  CAPS_OPENCODE_CHAT_1M,
  CAPS_OPENCODE_MESSAGES,
  CAPS_OPENCODE_MESSAGES_1M,
} from "./capabilities.ts"
export { registerOpencodeModel, registerOpencodeModels } from "./models.ts"
export { PRICING_OPENCODE_GENERIC } from "./pricing.ts"
