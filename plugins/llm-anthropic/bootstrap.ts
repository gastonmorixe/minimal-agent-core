/**
 * `/api/claude_cli/bootstrap` startup probe.
 *
 * New in claude-code v2.1.154. Returns:
 *
 *   {
 *     client_data: null,
 *     additional_model_options: <opts override map> | null,
 *     additional_model_costs: <pricing override map> | null,
 *     oauth_account: { account_uuid, account_email, organization_uuid,
 *                      organization_name, organization_type,
 *                      organization_rate_limit_tier, user_rate_limit_tier,
 *                      seat_tier }
 *   }
 *
 * The `additional_model_costs` field is the interesting one: Anthropic
 * can ship a new model id without releasing a new CLI, and the cost
 * override lets billing keep up. We honor it by overlaying onto the
 * canonical model registry (see {@link applyBootstrapOverrides}).
 *
 * @module llm/providers/anthropic/bootstrap
 */

import type { MTokRate } from "../../src/llm/pricing.ts"
import type { ProviderAuth } from "../../src/llm/provider.ts"
import { defaultNetworkClient, type NetworkClient } from "../../src/network/index.ts"

import { BOOTSTRAP_URL_BASE, USER_AGENT_OAUTH } from "./wire-constants.ts"

// ---------------------------------------------------------------------------
// Types (loose; the field set is owned server-side)
// ---------------------------------------------------------------------------

export interface BootstrapOAuthAccount {
  account_uuid: string
  account_email: string
  organization_uuid: string
  organization_name: string
  organization_type?: string
  organization_rate_limit_tier?: string
  user_rate_limit_tier?: string | null
  seat_tier?: string | null
}

/**
 * Per-model cost override the server can ship. Same shape as our
 * {@link MTokRate} (camelCase), so it overlays directly. The server
 * returns wire-style names; we normalize.
 */
export interface BootstrapModelCost {
  inputTokens?: number
  outputTokens?: number
  promptCacheWriteTokens?: number
  promptCacheReadTokens?: number
  webSearchRequests?: number
}

export interface BootstrapResponse {
  client_data: unknown
  additional_model_options: Record<string, unknown> | null
  additional_model_costs: Record<string, BootstrapModelCost> | null
  oauth_account: BootstrapOAuthAccount | null
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

export interface FetchBootstrapOpts {
  auth: ProviderAuth
  modelId: string
  /** Defaults to "cli". */
  entrypoint?: string
  networkClient?: NetworkClient
  signal?: AbortSignal
}

/**
 * Issue the bootstrap GET. Returns `null` on any non-fatal failure
 * (the rest of the CLI uses fallbacks). Throws only on programmer
 * errors (missing auth, bad URL).
 */
export async function fetchBootstrap(opts: FetchBootstrapOpts): Promise<BootstrapResponse | null> {
  if (opts.auth.kind !== "oauth") {
    // Bootstrap is OAuth-only (per the live capture's `anthropic-beta:
    // oauth-2025-04-20` header). API-key callers don't have an account
    // entity to enumerate.
    return null
  }
  const entrypoint = opts.entrypoint ?? "cli"
  const url = `${BOOTSTRAP_URL_BASE}?entrypoint=${encodeURIComponent(entrypoint)}&model=${encodeURIComponent(opts.modelId)}`
  const networkClient = opts.networkClient ?? defaultNetworkClient
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "user-agent": USER_AGENT_OAUTH,
    authorization: `Bearer ${opts.auth.token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "accept-encoding": "gzip, compress, deflate, br",
  }
  try {
    const response = await networkClient.request({
      label: "bootstrap",
      method: "GET",
      url,
      headers,
      signal: opts.signal,
    })
    if (!response.ok) return null
    const text = await response.text()
    return JSON.parse(text) as BootstrapResponse
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Apply overrides to the model registry
// ---------------------------------------------------------------------------

/**
 * Overlay `additional_model_costs` onto registered models. Per-model
 * pricingForRequest closure is preserved (e.g. Opus 4.8 fast-mode);
 * only the base pricing rate is replaced.
 *
 * Skips silently when there are no overrides or the model isn't
 * registered (server may know models the CLI doesn't yet).
 */
export function applyBootstrapOverrides(
  bootstrap: BootstrapResponse | null,
  registry: typeof import("../../src/llm/model-registry.ts"),
): void {
  if (!bootstrap?.additional_model_costs) return
  for (const [modelId, raw] of Object.entries(bootstrap.additional_model_costs)) {
    const entry = registry.findModel(modelId)
    if (!entry) continue
    const overlay = normalizeCostOverride(raw, entry.pricing)
    // Re-register with overlaid pricing. The registry's last-write-wins
    // semantics replace the entry cleanly.
    registry.registerModel({ ...entry, pricing: overlay })
  }
}

function normalizeCostOverride(raw: BootstrapModelCost, current: MTokRate): MTokRate {
  return {
    inputUSD: raw.inputTokens ?? current.inputUSD,
    outputUSD: raw.outputTokens ?? current.outputUSD,
    cacheWriteUSD: raw.promptCacheWriteTokens ?? current.cacheWriteUSD,
    cacheReadUSD: raw.promptCacheReadTokens ?? current.cacheReadUSD,
    webSearchPerCallUSD: raw.webSearchRequests ?? current.webSearchPerCallUSD,
    reasoningUSD: current.reasoningUSD,
  }
}
