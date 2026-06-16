/**
 * Wire constants for OpenAI's HTTP API surfaces.
 *
 * Two endpoints live here side-by-side:
 *
 * - Chat Completions: `POST https://api.openai.com/v1/chat/completions`
 * - Responses:        `POST https://api.openai.com/v1/responses`
 *
 * Auth: API-key traffic uses the public `/v1/*` paths. ChatGPT plan OAuth
 * traffic uses the Codex backend path shape and carries account metadata via
 * provider-owned headers.
 *
 * Azure variant: same body shapes but different base URL + `api-key`
 * header. Out of scope for the first cut — track via env in the future.
 *
 * @module llm/providers/openai/wire-constants
 */

export const OPENAI_BASE_URL = "https://api.openai.com"

export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions"
export const RESPONSES_PATH = "/v1/responses"
export const CHATGPT_CODEX_RESPONSES_PATH = "/responses"

export const CHAT_COMPLETIONS_URL = `${OPENAI_BASE_URL}${CHAT_COMPLETIONS_PATH}`
export const RESPONSES_URL = `${OPENAI_BASE_URL}${RESPONSES_PATH}`

/**
 * User-Agent the adapter advertises. Mirrors what the official OpenAI
 * Node SDK sends (modulo platform fields), simplified for our use.
 */
export const OPENAI_USER_AGENT = "minimal-agent-openai/0.1"
