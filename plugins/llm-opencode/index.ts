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
  // Chat surface
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_DEEPSEEK_V4_FLASH,
  CAPS_GLM_5_2,
  CAPS_GLM_5_1,
  CAPS_GLM_5,
  CAPS_KIMI_K2_7_CODE,
  CAPS_KIMI_K2_6,
  CAPS_MIMO_V2_5,
  CAPS_MIMO_V2_5_PRO,
  // Messages surface
  CAPS_MINIMAX_M3,
  CAPS_MINIMAX_M2_7,
  CAPS_MINIMAX_M2_5,
  CAPS_QWEN3_7_MAX,
  CAPS_QWEN3_7_PLUS,
  CAPS_QWEN3_6_PLUS,
  // Fallbacks
  CAPS_OPENCODE_CHAT_FALLBACK,
  CAPS_OPENCODE_MESSAGES_FALLBACK,
} from "./capabilities.ts"
export { registerOpencodeModel, registerOpencodeModels } from "./models.ts"
export {
  PRICING_OPENCODE_GENERIC,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_GLM_5_2,
  PRICING_GLM_5_1,
  PRICING_GLM_5,
  PRICING_KIMI_K2_7_CODE,
  PRICING_KIMI_K2_6,
  PRICING_MIMO_V2_5,
  PRICING_MIMO_V2_5_PRO,
  PRICING_MINIMAX_M3,
  PRICING_MINIMAX_M2_7,
  PRICING_MINIMAX_M2_5,
  PRICING_QWEN3_7_MAX,
  PRICING_QWEN3_7_PLUS,
  PRICING_QWEN3_6_PLUS,
} from "./pricing.ts"
