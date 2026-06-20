/**
 * Wire constants for the Wafer Serverless API.
 *
 * Wafer exposes an OpenAI-compatible Chat Completions surface at
 * `https://pass.wafer.ai/v1/chat/completions` and a model list at
 * `GET /v1/models`.
 *
 * The Anthropic-compatible Messages endpoint is announced but not yet
 * wired through this plugin; add it when a surface adapter exists.
 *
 * @module llm/providers/wafer/wire-constants
 */

/** Base URL for the Wafer Serverless API. */
export const WAFER_BASE_URL = "https://pass.wafer.ai"

/** Chat Completions endpoint (OpenAI-compatible). */
export const CHAT_COMPLETIONS_URL = `${WAFER_BASE_URL}/v1/chat/completions`

/** Model-list endpoint. Call to discover the live catalog. */
export const MODELS_URL = `${WAFER_BASE_URL}/v1/models`

/**
 * User-Agent the adapter advertises. Mirrors the convention established
 * by the OpenAI provider (`OPENAI_USER_AGENT`).
 */
export const WAFER_USER_AGENT = "minimal-agent-wafer/0.1"

/**
 * Optional header to require Zero Data Retention (ZDR) on a per-request
 * basis. Set to `"required"` when the model supports it
 * (`zdr_supported: true`).
 */
export const WAFER_ZDR_HEADER = "Wafer-ZDR"
