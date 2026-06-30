/**
 * Provider-neutral startup-banner / welcome-card decisions.
 *
 * Wave C unit C-2 (PLAN.md): the boot path in `src/index.ts` used to hardcode
 * provider tokens for three cosmetic decisions:
 *
 *   - the first-run welcome card's "sign in to your <provider>" step label,
 *   - whether the banner shows the thinking / effort rows (it keyed off a
 *     `model.includes("haiku")` substring), and
 *   - whether boot blocks on a synchronous quota probe (it keyed off
 *     `selectedProviderId !== "anthropic"`).
 *
 * All three are now derived from neutral seams: the selected provider's
 * declared `displayName`, the model registry's capability flags, and a
 * provider's declared session-probe hook. Core names no provider here, so the
 * I1 ratchet stays clean even as new providers land.
 *
 * Pure + synchronous (registry reads only); easy to unit-test in isolation
 * (`provider-presentation.test.ts`).
 *
 * @module startup/provider-presentation
 */

import { discoverCredentialedProviders } from "../../auth-strategies.ts"
import { findModel } from "../../llm/model-registry.ts"
import { findProviderPlugin } from "../../llm/provider-plugin.ts"

/** Strip the optional `[1m]` / `[2m]` context-window variant suffix. */
function baseModelId(modelId: string): string {
  return modelId.replace(/\[(1|2)m\]/gi, "")
}

/**
 * Label for the first-run welcome card's sign-in step. When exactly one
 * provider already has credentials, names that provider; otherwise stays
 * neutral so core never hardcodes a vendor.
 */
export function signInStepLabel(): string {
  const credentialed = discoverCredentialedProviders()
  if (credentialed.length === 1) {
    return `sign in to your ${credentialed[0]!.displayName} account`
  }
  return "sign in to your account"
}

/**
 * Should the startup banner HIDE the thinking + effort rows for `modelId`?
 *
 * True only for a "cheap/fast tier" model that supports neither adaptive/
 * extended thinking NOR an effort parameter — for such a model the agent
 * sends neither field on the wire, so the rows would read a misleading
 * "off". This replaces the old `model.includes("haiku")` substring match
 * with a capability-driven test (any provider's cheap tier qualifies).
 *
 * An unknown / unregistered model id returns false (show the rows): we can't
 * prove it lacks the capability, and showing the rows is the safe default.
 */
export function modelHidesReasoning(modelId: string): boolean {
  const entry = findModel(baseModelId(modelId))
  if (!entry) return false
  const { thinking, effort } = entry.capabilities
  const hasThinking = thinking.adaptive || thinking.extended
  const hasEffort = effort.levels.length > 0
  return !hasThinking && !hasEffort
}

/**
 * Does the selected provider want a blocking startup quota probe?
 *
 * A provider opts in by declaring the session-probe seam
 * ({@link ProviderPlugin.primeSessionInfo}) — the same hook that warms the
 * status-bar quota cache. Providers whose quota fills from real chat traffic
 * (and providers with no quota concept) declare no such hook and skip the
 * blocking boot probe. Replaces the old `selectedProviderId !== "anthropic"`
 * hardcode.
 *
 * `undefined` / unknown provider id ⇒ false (no probe).
 */
export function providerWantsQuotaProbe(providerId: string | undefined): boolean {
  if (!providerId) return false
  return typeof findProviderPlugin(providerId)?.primeSessionInfo === "function"
}
