/**
 * Per-request header builder for OpenAI Chat Completions + Responses.
 *
 * Both surfaces share the same header set; the path differs.
 *
 * @module llm/providers/openai/headers
 */

import type { ProviderAuth } from "@minimal-agent/plugin-api/llm/provider-auth"

import { OPENAI_USER_AGENT } from "./wire-constants.ts"

export interface OpenAIHeadersOpts {
  auth: ProviderAuth
  /** Optional explicit `OpenAI-Beta` header value. */
  beta?: string
}

/** Build the auth + content headers for a Chat/Responses API request. */
export function buildOpenAIHeaders(opts: OpenAIHeadersOpts): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": OPENAI_USER_AGENT,
  }

  switch (opts.auth.kind) {
    case "api-key":
      headers.authorization = `Bearer ${opts.auth.key}`
      if (opts.auth.organization) headers["openai-organization"] = opts.auth.organization
      if (opts.auth.project) headers["openai-project"] = opts.auth.project
      break
    case "oauth":
      headers.authorization = `Bearer ${opts.auth.token}`
      if (opts.auth.headers) Object.assign(headers, opts.auth.headers)
      break
    case "custom":
      Object.assign(headers, opts.auth.headers)
      break
  }

  if (opts.beta) headers["openai-beta"] = opts.beta
  return headers
}
