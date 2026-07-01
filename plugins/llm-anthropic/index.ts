/**
 * Public surface for the Anthropic provider plugin.
 *
 * @module llm/providers/anthropic
 */

export {
  anthropicAdapter,
  anthropicProviderPlugin,
  bootstrapAnthropic,
  registerAnthropicAdHocModel,
} from "./adapter.ts"
export {
  ANTHROPIC_BETA_FLAGS,
  type AnthropicBetaFlag,
  type AnthropicRequestKind,
  buildBetaFlags,
  classifyRequest,
} from "./beta-flags.ts"
export {
  applyBootstrapOverrides,
  type BootstrapModelCost,
  type BootstrapOAuthAccount,
  type BootstrapResponse,
  type FetchBootstrapOpts,
  fetchBootstrap,
} from "./bootstrap.ts"
export {
  CAPS_HAIKU_45,
  CAPS_OPUS_46,
  CAPS_OPUS_47,
  CAPS_OPUS_48,
  CAPS_SONNET_45,
  CAPS_SONNET_46,
} from "./capabilities.ts"
export { buildAnthropicHeaders } from "./headers.ts"
export {
  buildMetadata,
  buildUserId,
  getDeviceId,
  type IdentityAuth,
  loadExtraMetadata,
} from "./identity.ts"
export {
  registerAnthropicAdHocModelInto,
  registerAnthropicModels,
  sonnet5RateForDate,
} from "./models.ts"
export {
  ANTHROPIC_PLAN_OAUTH,
  type AnthropicCredentialsData,
  type AnthropicTokenExchangeResponse,
  anthropicCredentialsToSecrets,
  anthropicOAuthLogin,
  anthropicOAuthLoginConfig,
  buildAnthropicOAuthCredential,
  CLAUDE_AI_AUTHORIZE_URL,
  LOGIN_SCOPES,
  MANUAL_REDIRECT_URL,
} from "./oauth-login.ts"
export {
  type AnthropicRequestBody,
  buildAnthropicRequestBody,
} from "./request-body.ts"
export {
  type AnthropicStreamEvent,
  translateAnthropicStream,
} from "./response-stream.ts"
export {
  extractModelFromSignature,
  looksLikeAnthropicModelId,
} from "./signature-model.ts"
export {
  applyMismatchResolution,
  buildMismatchIssue,
  findThinkingMismatches,
  ISSUE_THINKING_MODEL_MISMATCH,
  type MismatchResolutionOutcome,
  normalizeModelId,
  OPTION_CANCEL,
  OPTION_STRIP,
  OPTION_SWITCH_PREFIX,
  stripThinkingBlocks,
  type ThinkingMismatch,
} from "./thinking-preflight.ts"
export { validateAnthropicRequest } from "./validate.ts"
