/**
 * Per-request header builder for the Anthropic Messages API.
 *
 * Mirrors `cli.patched.cjs` v2.1.154 + the live 2026-05-28 capture
 * exactly. New code goes here; the legacy `src/headers.ts` retains
 * its `buildHeaders` for backward compatibility until Phase 7
 * removes it.
 *
 * @module llm/providers/anthropic/headers
 */

import { randomUUID } from "node:crypto"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import type { ModelEntry } from "../../src/llm/model-registry.ts"
import type { ProviderAuth } from "../../src/llm/provider.ts"

import { type AnthropicBetaFlag, buildBetaFlags, classifyRequest } from "./beta-flags.ts"
import { ANTHROPIC_VERSION, STAINLESS_SDK_VERSION, USER_AGENT } from "./wire-constants.ts"

export interface AnthropicHeadersOptions {
  req: CanonicalRequest
  model: ModelEntry
  auth: ProviderAuth
  sessionId: string
  /** Override the per-request UUID. Defaults to a fresh `randomUUID()`. */
  clientRequestId?: string
}

/**
 * Build the full header map. The order is not significant for HTTP
 * but matches the live capture for diff-ability.
 *
 * Returns `{ headers, betaFlags }` so the caller can record the
 * resolved flag list for diagnostics without re-running the assembler.
 */
export function buildAnthropicHeaders(opts: AnthropicHeadersOptions): {
  headers: Record<string, string>
  betaFlags: AnthropicBetaFlag[]
} {
  const { req, model, auth, sessionId, clientRequestId } = opts
  const kind = classifyRequest(req)
  const betaFlags = buildBetaFlags({
    kind,
    req,
    model,
    authKind: auth.kind,
  })

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "user-agent": USER_AGENT,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
    "x-client-request-id": clientRequestId ?? randomUUID(),
  }

  if (auth.kind === "api-key") {
    headers["x-api-key"] = auth.key
    if (auth.organization) headers["anthropic-organization"] = auth.organization
    if (auth.project) headers["anthropic-project"] = auth.project
  } else if (auth.kind === "oauth") {
    headers["authorization"] = `Bearer ${auth.token}`
    headers["anthropic-beta"] = betaFlags.join(",")
    headers["anthropic-dangerous-direct-browser-access"] = "true"
  } else {
    Object.assign(headers, auth.headers)
    if (betaFlags.length > 0) headers["anthropic-beta"] = betaFlags.join(",")
  }

  // Stainless metadata. Mirrors what the SDK injects.
  headers["x-stainless-arch"] = process.arch
  headers["x-stainless-lang"] = "js"
  headers["x-stainless-os"] = process.platform === "darwin" ? "MacOS" : process.platform
  headers["x-stainless-package-version"] = STAINLESS_SDK_VERSION
  headers["x-stainless-retry-count"] = "0"
  headers["x-stainless-runtime"] = "node"
  headers["x-stainless-runtime-version"] = process.version
  headers["x-stainless-timeout"] = "600"

  return { headers, betaFlags }
}
