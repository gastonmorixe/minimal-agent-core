/**
 * Wire constants for HuggingFace Inference Providers.
 *
 * HuggingFace exposes an OpenAI-compatible Chat Completions API at
 * `https://router.huggingface.co/v1/chat/completions`. The Responses
 * API is not yet wired (the adapter only speaks the Chat surface).
 *
 * Auth: an API key (a HuggingFace fine-grained token with "Make calls
 * to Inference Providers" permission), stored via the login command.
 *
 * @module llm/providers/huggingface/wire-constants
 */

export const HUGGINGFACE_BASE_URL = "https://router.huggingface.co"

export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
export const MODELS_PATH = "/v1/models"

export const CHAT_COMPLETIONS_URL = `${HUGGINGFACE_BASE_URL}${CHAT_COMPLETIONS_PATH}`

/**
 * OpenAI-compatible model-listing endpoint. Returns a JSON object with a
 * `data` array, one entry per chat-completion model the router serves (each
 * carrying `id`, `created`, `owned_by`). Used by the `listLiveModels` hook so
 * the picker shows the full live catalog, not just the static snapshot in
 * `./models.ts`.
 */
export const MODELS_URL = `${HUGGINGFACE_BASE_URL}${MODELS_PATH}`

/**
 * User-Agent the adapter advertises.
 */
export const HUGGINGFACE_USER_AGENT = "minimal-agent-huggingface/0.1"
