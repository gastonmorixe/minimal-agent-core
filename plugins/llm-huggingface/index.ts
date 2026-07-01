/**
 * Public surface for the HuggingFace Inference Providers plugin.
 *
 * @module llm/providers/huggingface
 */

export {
  bootstrapHuggingFace,
  huggingfaceAdapter,
  huggingfaceProviderPlugin,
  registerHuggingFaceAdHocModel,
} from "./adapter.ts"
export {
  buildHuggingfaceApiKeyCredential,
  HUGGINGFACE_API_KEY_AUTH,
  huggingfaceApiKeyAuth,
  huggingfaceApiKeyToSecrets,
  readHuggingfaceApiKey,
} from "./auth.ts"
export { CAPS_HUGGINGFACE_CHAT } from "./capabilities.ts"
export {
  epochToIsoDate,
  listHuggingFaceLiveModels,
  mapHuggingFaceLiveModels,
} from "./live-models.ts"
export { registerHuggingFaceModel, registerHuggingFaceModels } from "./models.ts"
export {
  PRICING_HF_DEEPSEEK_V3,
  PRICING_HF_GENERIC,
  PRICING_HF_GPT_OSS_120B,
  PRICING_HF_QWEN3_32B,
} from "./pricing.ts"
export {
  CHAT_COMPLETIONS_URL,
  HUGGINGFACE_BASE_URL,
  HUGGINGFACE_USER_AGENT,
} from "./wire-constants.ts"
