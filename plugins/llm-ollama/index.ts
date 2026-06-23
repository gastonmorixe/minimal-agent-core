/**
 * Public surface for the Ollama Cloud provider (native `/api/chat` protocol).
 *
 * A self-contained provider plugin: it depends only on
 * `@minimal-agent/plugin-api` and the agent-loop setup/run contexts, never on
 * `src/` or sibling plugins.
 *
 * @module llm/providers/ollama
 */

export {
  bootstrapOllama,
  ollamaAdapter,
  ollamaProviderPlugin,
  registerOllamaAdHocModel,
} from "./adapter.ts"
export {
  buildOllamaApiKeyCredential,
  inspectOllamaApiKeyCredential,
  OLLAMA_API_KEY_AUTH,
  ollamaApiKeyAuth,
  ollamaApiKeyToSecrets,
  readOllamaApiKey,
} from "./auth.ts"
export { ollamaCaps } from "./capabilities.ts"
export { listOllamaLiveModels } from "./live-models.ts"
export {
  registerOllamaAdHocModelInto,
  registerOllamaModelInto,
  registerOllamaModels,
} from "./models.ts"
export { PRICING_OLLAMA_GENERIC } from "./pricing.ts"
export { buildOllamaChatBody } from "./request-body.ts"
export { type OllamaChatChunk, parseNdjson, translateOllamaStream } from "./response-stream.ts"
export {
  accumulateOllamaUsage,
  clearOllamaSessionUsage,
  fetchOllamaSessionInfo,
  getOllamaSessionUsage,
} from "./session-info.ts"
export { validateOllamaRequest } from "./validate.ts"
