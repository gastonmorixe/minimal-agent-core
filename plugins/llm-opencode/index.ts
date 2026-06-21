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
  CAPS_DEEPSEEK_V4_FLASH,
  // Chat surface
  CAPS_DEEPSEEK_V4_PRO,
  CAPS_GLM_5,
  CAPS_GLM_5_1,
  CAPS_GLM_5_2,
  CAPS_KIMI_K2_6,
  CAPS_KIMI_K2_7_CODE,
  CAPS_MIMO_V2_5,
  CAPS_MIMO_V2_5_PRO,
  CAPS_MINIMAX_M2_5,
  CAPS_MINIMAX_M2_7,
  // Messages surface
  CAPS_MINIMAX_M3,
  // Fallbacks
  CAPS_OPENCODE_CHAT_FALLBACK,
  CAPS_OPENCODE_MESSAGES_FALLBACK,
  CAPS_QWEN3_6_PLUS,
  CAPS_QWEN3_7_MAX,
  CAPS_QWEN3_7_PLUS,
} from "./capabilities.ts"
export { registerOpencodeModel, registerOpencodeModels } from "./models.ts"
export {
  PRICING_DEEPSEEK_V4_FLASH,
  PRICING_DEEPSEEK_V4_PRO,
  PRICING_GLM_5,
  PRICING_GLM_5_1,
  PRICING_GLM_5_2,
  PRICING_KIMI_K2_6,
  PRICING_KIMI_K2_7_CODE,
  PRICING_MIMO_V2_5,
  PRICING_MIMO_V2_5_PRO,
  PRICING_MINIMAX_M2_5,
  PRICING_MINIMAX_M2_7,
  PRICING_MINIMAX_M3,
  PRICING_OPENCODE_GENERIC,
  PRICING_QWEN3_6_PLUS,
  PRICING_QWEN3_7_MAX,
  PRICING_QWEN3_7_PLUS,
} from "./pricing.ts"
