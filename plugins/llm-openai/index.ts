/**
 * Public surface for the OpenAI provider.
 *
 * @module llm/providers/openai
 */

export { bootstrapOpenAI, openaiAdapter, openaiProviderPlugin } from "./adapter.ts"
export {
  buildOpenAIApiKeyCredential,
  OPENAI_API_KEY_AUTH,
  openAIApiKeyAuth,
  openAIApiKeyToSecrets,
  readOpenAIApiKey,
} from "./auth.ts"
export {
  CAPS_GPT_4O_CHAT,
  CAPS_GPT_4O_MINI_CHAT,
  CAPS_GPT_5_5_CHAT,
  CAPS_GPT_5_5_RESPONSES,
  CAPS_GPT_5_RESPONSES,
  CAPS_GPT_41_CHAT,
  CAPS_O3_CHAT,
  CAPS_O3_RESPONSES,
  CAPS_O4_MINI_CHAT,
  CAPS_O4_MINI_RESPONSES,
} from "./capabilities.ts"
export {
  buildOpenAIChatBody,
  type OpenAIChatRequestBody,
} from "./chat/request-body.ts"
export {
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "./chat/response-stream.ts"
export { buildOpenAIHeaders, type OpenAIHeadersOpts } from "./headers.ts"
export { registerOpenAIModels } from "./models.ts"
export {
  PRICING_GPT_4O,
  PRICING_GPT_4O_MINI,
  PRICING_GPT_5,
  PRICING_GPT_5_5,
  PRICING_GPT_41,
  PRICING_O3,
  PRICING_O4_MINI,
} from "./pricing.ts"
export {
  buildOpenAIResponsesBody,
  type OpenAIResponsesRequestBody,
} from "./responses/request-body.ts"
export {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"
export { validateOpenAIRequest } from "./validate.ts"
export {
  CHAT_COMPLETIONS_URL,
  OPENAI_BASE_URL,
  OPENAI_USER_AGENT,
  RESPONSES_URL,
} from "./wire-constants.ts"
