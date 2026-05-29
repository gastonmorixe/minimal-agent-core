# Providers own session metadata + system prompt; configurable status bar

**Status:** shipped (provider-resolved system prompt, provider session-metadata seam, declarative status-bar config, rock-solid quota probe).
**Owner:** agent (session bc476c06)
**Builds on:** [`2026-05-28-openai-provider-and-plugin-seam.md`](./2026-05-28-openai-provider-and-plugin-seam.md) (the `ProviderPlugin` contract) and the canonical transport's resilience work (TTFB guard + abort escalation).

Two hardcoded Anthropic couplings are gone: the system prompt and the quota/footer no longer assume Anthropic for every provider. Both now resolve through the model's provider via the registry seam, so a sub-agent on a different provider transparently gets ITS preamble + ITS session stats. The status bar is configurable. The quota probe can no longer wedge.

## What shipped

### 1. Provider-resolved system prompt

The agent used to send, to EVERY model, the Anthropic billing header
(`x-anthropic-billing-header: …`) and identity (`You are Claude Code, …`),
hardcoded in `headers.ts`. That is Anthropic-plan-auth specific and wrong for
other providers.

- New `src/llm/system-prompt.ts`: provider-neutral builder. `NEUTRAL_IDENTITY`
  = `"You are Minimal Agent, a minimalistic AI agent CLI harness for the terminal."`,
  `buildAgentSystemBody()` (instructions + session context), and
  `resolveSystemPromptForModel(modelId, { authKind, … })` which builds the
  neutral skeleton and delegates to the provider.
- New `ProviderPlugin.resolveSystemPrompt(ctx)` hook (Strategy/Template Method):
  the agent builds the skeleton, the provider returns the final wire blocks.
  Default = `neutralSystemPrompt` (neutral identity + body unchanged).
- Anthropic (`plugins/llm-anthropic/system-prompt.ts`) owns billing + identity:
  **OAuth/plan auth → byte-exact `[billing, "You are Claude Code, …", …body]`**
  (their server validates the prefix); **api-key/custom → neutral identity, no
  billing**. So a raw Anthropic API key (not a subscription) gets the honest
  Minimal Agent identity.
- `agent.ts` and `index.ts` (resume-drift `systemHash`) both route through
  `resolveSystemPromptForModel(normalizeModelForAPI(model), { authKind })`, so
  the cached prefix stays byte-consistent across the two call sites.
- `headers.buildSystemPrompt` / `SYSTEM_PROMPT` are frozen as a `@deprecated`
  legacy shim (the legacy `client.ts` default); its instructions block is
  assembled by the shared `buildInstructionsBlockText`, so the neutral builder
  is byte-identical. Anthropic fixtures stay green (the adapter renders
  `req.system` verbatim; the transform happens at the agent layer).

### 2. Provider session-metadata seam (quota / context / label)

The `quota-status` footer used to `import { checkQuota, has1mContext }` straight
from `client.ts` — hardwired to Anthropic.

- Neutral DTO in `provider-plugin.ts`: `QuotaWindow` / `QuotaSnapshot` /
  `ProviderSessionInfo` (`{ contextWindow?, modelLabel?, quota? }`) +
  `ProviderSessionContext`, and a `ProviderPlugin.fetchSessionInfo(ctx)` hook.
- Core resolver `src/llm/provider-session.ts`: `resolveProviderSessionInfo(modelId)`
  routes to the provider; never throws; degrades to a context-only view
  (context window + label from the model registry) when a provider has no hook,
  fails, or the model is unknown. `contextWindowForModel` reads
  `ModelEntry.capabilities.contextWindow` (already provider-neutral).
- Anthropic (`plugins/llm-anthropic/session-info.ts`) implements it: cache-first
  (the in-process `quota-cache`), else a bounded probe over the SHARED transport;
  parses `anthropic-ratelimit-*` → neutral windows (the provider owns its wire
  format).
- `quota-status/handler.ts` is now provider-agnostic: it asks
  `resolveProviderSessionInfo(currentModelId(), { signal: ctx.abort })` and reads
  context window + label from the DTO. No `has1mContext`, no `MINIMAL_AGENT_MODEL`
  context hack, no provider name.

### 3. Configurable status bar (declarative)

- `render.ts`: `StatusSegmentId` (`quota | context | model | sid`),
  `DEFAULT_SEGMENT_ORDER`, `normalizeSegmentOrder` (lenient), and `build()`
  refactored to render an ordered, capability-filtered segment list. The
  compression ladder is unchanged; default order output is byte-identical.
- `UserConfig.statusBar.segments` (config.jsonc): reorder / hide segments
  declaratively. Unknown ids ignored; empty/all-invalid → default (never blanks
  the footer). A listed segment with no data (e.g. `quota` on a no-quota
  provider) renders nothing — capability-adaptive.
- `renderQuotaFooter` is overloaded: neutral `QuotaWindow[]` (production) OR the
  legacy `ReadonlyMap` (back-compat, so the 53 render tests are untouched).
- Future `statusBar.script` (full custom renderer) is documented as a planned
  seam, not implemented.

### 4. Rock-solid quota probe

`checkQuota` now composes the caller's signal with an internal
`AbortSignal.timeout(15s)`, so the probe is ALWAYS bounded — even the
startup-tree caller (which passes no signal) can no longer hang on a stalled
probe. It rides the shared transport, so it inherits the TTFB guard +
abort-escalation + wedged-session eviction. Long-running sessions never wedge
the footer; a failed tick degrades to context-only and the scheduler re-fires.

## Patterns

Strategy + Template Method (provider preamble / quota source), DTO
(`ProviderSessionInfo`), Registry/DI seam (`findProviderPlugin`, no provider
named by the agent), Result-ish (`resolveProviderSessionInfo` never throws).

## Tests

+5 system-prompt, +8 provider-session, +8 status-bar segments, +2 config,
updated 2 checkQuota signal assertions. Full suite **3497 pass / 0 fail**;
typecheck clean; touched files lint-clean (the only warning is the pre-existing
`client.ts` max-lines).

## Deferred (documented)

- `checkQuota` still carries a duplicated 401 keychain-first block (a copy of
  `sendMessageOnce`'s). Cleanliness only — it works and is now bounded. Proper
  fix: move it into the Anthropic plugin behind the canonical `withAuthRefresh`
  middleware (a larger legacy-path refactor).
- The `index.ts` startup-tree quota row still calls `checkQuota` +
  `formatQuotaSummary` directly; it's already provider-gated to Anthropic and
  only fires when no live quota slot exists.
- The neutral footer path drops the niche `MINIMAL_AGENT_QUOTA_OVERAGE` "overage
  off" readout (legacy map path only). Can be added to the DTO later.
