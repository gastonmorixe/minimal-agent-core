# Wafer Plugin Test Gaps

Analysis date: 2026-06-19. Compared against wafer.test.ts (10 existing tests), OpenRouter test (7 tests), OpenAI test (30+ tests), Anthropic test (25+ tests), and all Wafer source files.

## Current coverage (wafer.test.ts): 10 tests

1. Auth strategy shape (API-key yes, OAuth no)
2. API-key credential codec (build/read/inspect)
3. Single model registration on openai-chat-completions surface
4. All 10 built-in model IDs registered
5. Ad-hoc model registration
6. SSE pong replay through reused OpenAI translator
7. Plain request validation through reused OpenAI validator
8. Sub-agent model recommendations by tag
9. Pricing for 3 models (GLM-5.1, deepseek-v4-flash, qwen3.7-max)
10. Live round-trip (gated on MINIMAL_AGENT_WAFER_LIVE_KEY)

## Missing Tests by Priority

### CRITICAL (1 test)

**1. taggedHttpError error classification — streamErrorType mapping**

Covers: The adapter.ts `taggedHttpError` function calls `parseWaferErrorCode` on the response body, then feeds the result into `classifyUpstreamError` to set `streamErrorType`. This is the sole path that makes Wafer HTTP errors retryable vs fatal. It is currently untested.

Why critical: Without this test, a regression in error-code parsing could turn every 429/503 into a fatal error the agent loop cannot recover from. The live test only catches 402/401 in its catch block and does not inspect the error tag at all.

Approach: Use a fake `NetworkClient` (like OpenAI's `captureFailingNetwork` pattern) to simulate HTTP error responses with specific status codes and body shapes. Verify the thrown error carries `streamErrorType`:

- 429 + body `{"error":{"code":"rate_limit_error","message":"..."}}` → `streamErrorType: "rate_limit_error"`
- 503 + body `{"error":{"code":"server_error","message":"..."}}` → `streamErrorType: "overloaded_error"`
- 500 + body `{"error":{"type":"server_error","message":"..."}}` → `streamErrorType: "overloaded_error"`
- 402 + body `{"error":{"code":"insufficient_quota","message":"..."}}` → untagged (terminal)
- 401 + body `{"error":{"code":"invalid_api_key","message":"..."}}` → untagged (auth-refresh owns it)
- 400 + body `{"error":{"code":"invalid_request_error","message":"..."}}` → untagged (terminal)
- Non-JSON body (e.g. plain text "Gateway Timeout") → still classified by HTTP status alone
- 429 + JSON body with NO error code (only status-based classification)
- Also test `parseWaferErrorCode` directly: extracts `code` field, falls back to `type` field, returns undefined for non-JSON

### HIGH (7 tests)

**2. Session-info: parseWaferQuotaWindows + parseResetMs**

Covers: `parseWaferQuotaWindows` builds `QuotaWindow[]` from x-ratelimit-* headers. `parseResetMs` parses reset duration strings. Both are exported but never tested.

Why high: The status-bar footer depends on these to show quota utilization. Broken parsing → wrong utilization display or missing windows.

Approach: Unit tests (no registry setup needed):

- parseResetMs: "1s" → 1000, "6m0s" → 360000, "13ms" → 13, "1.5s" → 1500, "0s" → 0, "" → undefined, garbage → undefined, "1h30m" → 5400000
- parseWaferQuotaWindows: build a fake `ReadonlyMap` with limit/remaining/reset headers, verify req/tok windows with correct utilization (e.g. limit=100, remaining=50 → utilization=0.5), limit=0 → window skipped, missing remaining → skipped, missing reset → window has no resetAtMs
- Full round-trip: `setWaferRateLimits` → `parseWaferQuotaWindows`

**3. Session-info: setWaferRateLimits + cache freshness + accumulateWaferUsage**

Covers: `setWaferRateLimits` captures headers, `getWaferRateLimits` reads the cache, `getWaferSessionUsage` reads accumulated usage, `clearWaferRateLimits` resets for test isolation, `accumulateWaferUsage` accumulates across responses.

Why high: The adapter calls these on every successful response. Broken capture → broken quota display. The freshness gate (5 min) must work.

Approach:

- `setWaferRateLimits` with real x-ratelimit-* headers → cache populated, empty headers → cache not updated (null stays null)
- `accumulateWaferUsage` first call → sets sessionUsage, second call → adds to totals
- `getWaferRateLimits` / `getWaferSessionUsage` read back correctly
- `clearWaferRateLimits` resets both to null
- Cache expiry: `fetchWaferSessionInfo` returns `{}` (no windows) when cache is older than 5 min
- `fetchWaferSessionInfo` with fresh cache returns contextWindow + modelLabel + quota windows
- `fetchWaferSessionInfo` with no cache returns `{}`

**4. Session-info: primeWaferSessionInfo dedupe + cache-fresh skip**

Covers: The `inFlightPrime` latch deduplicates concurrent callers. Fresh cache (<5 min) skips the network probe entirely. No API key → silent return. Network error → soft-fail.

Why high: The prime runs on every cold start. If dedupe breaks, multiple probes fire simultaneously. If the freshness gate breaks, every status-bar tick hits the network.

Approach:

- Call `primeWaferSessionInfo` twice concurrently → second call returns the first's promise (not a new one)
- After first completes, `inFlightPrime` is cleared → next call starts a new probe
- With fresh cache (<5 min old) → prime returns immediately without network call
- With no API key resolution → prime returns silently (no network call)
- With network error → prime catches and returns (soft-fail), cache not polluted
- Use `_resetWaferPrimeInFlight` between test cases

**5. Capability validation: each model's key capabilities are correct**

Covers: All 10 models' `Capabilities` tables are pinned in `capabilities.ts` but never verified against the registry. The OpenRouter and Anthropic tests both pin individual model capabilities.

Why high: A wrong capability (e.g. setting `thinking.adaptive = false` on a model that supports reasoning) silently degrades the agent's behavior for that model.

Approach: After `setup()`, verify each model via `resolveModel()`:

- GLM-5.1: `contextWindow = 202752`, `maxOutputTokens = 8192`, `thinking.adaptive = true`, `effort.levels = ["low","medium","high"]`, `modalities.image = false`
- GLM-5.2: `contextWindow = 1048576`, same shape as 5.1 but larger window
- Kimi-K2.6: `modalities.image = true`, `contextWindow = 262144`
- Kimi-K2.7-Code: `modalities.image = false` (no vision), `contextWindow = 262144`
- Qwen3.5-397B-A17B: `contextWindow = 262144`, `thinking.adaptive = true`
- Qwen3.6-35B-A3B: `thinking.adaptive = false`, `effort.levels = []` (no effort control), `contextWindow = 256000`
- qwen3.7-max: `contextWindow = 256000`, `effort.levels = ["low","medium","high"]`, `pricing.inputUSD = 5.0`
- deepseek-v4-flash: `contextWindow = 1000000`, `tags` includes `"cheap"` and `"scout"`
- deepseek-v4-pro: `contextWindow = 1000000`, `tags` includes `"flagship"` and `"deep"`
- MiniMax-M3: `thinking.interleaved = true`, `contextWindow = 1048576`
- Also verify `speedFast = false` for all models (none advertise fast tier)

**6. Error recovery on the run() path: fake network client**

Covers: The adapter's `run()` method catches non-2xx responses via `taggedHttpError`. Test with a fake `NetworkClient` that returns specific errors, assert the error is properly tagged.

Why high: This is the real error path the agent loop takes. The OpenRouter test has no equivalent (it just throws plain `Error`). The OpenAI test has a full `captureFailingNetwork` pattern with `stream_error` event tests. The Wafer adapter has the machinery but no test exercising it.

Approach: Model after `captureFailingNetwork` from openai.test.ts:

- Create a fake `NetworkClient` whose `request()` returns `{ ok: false, status, text: async () => body }`
- Run `waferAdapter.run()` with this client against a real model
- Catch the thrown error and verify `streamErrorType`:
  - 429 with `{"error":{"code":"rate_limit_error"}}` → `streamErrorType: "rate_limit_error"`
  - 503 with `{"error":{"code":"server_error"}}` → `streamErrorType: "overloaded_error"`
  - 402 with `{"error":{"code":"insufficient_quota"}}` → untagged (terminal billing)
  - Non-JSON body `"Gateway Timeout"` with status 504 → still classified by status
- Also verify the error message includes the status code and label

**7. Complete pricing table: all 10 models**

Covers: The current test verifies pricing for only 3 of 10 models (GLM-5.1, deepseek-v4-flash, qwen3.7-max). The other 7 are untested.

Why high: Pricing feeds the footer's cost estimate. A wrong price on a frequently-used model distorts session cost display.

Approach: Extend the existing pricing test to cover all 10:

- GLM-5.2: inputUSD = 1.2, outputUSD = 4.1
- Kimi-K2.6: inputUSD = 0.68, outputUSD = 3.15
- Kimi-K2.7-Code: inputUSD = 0.95, outputUSD = 4.0
- Qwen3.5-397B-A17B: inputUSD = 0.43, outputUSD = 2.6
- Qwen3.6-35B-A3B: inputUSD = 0.15, outputUSD = 1.0
- MiniMax-M3: inputUSD = 0.33, outputUSD = 1.32
- deepseek-v4-pro: inputUSD = 1.2, outputUSD = 2.4

### MEDIUM (7 tests)

**8. modelVersionToken for all 10 model families**

Covers: `waferProviderPlugin.modelVersionToken` strips vendor prefixes for dense labels. Currently tested nowhere.

Why medium: This is a display-only function (labels in the UI). Wrong output is cosmetic, not behavioral. But the function is in the plugin surface and should be verified.

Approach: Test each family:

- `"GLM-5.1"` → `"5.1"`
- `"GLM-5.2"` → `"5.2"`
- `"Kimi-K2.6"` → `"K2.6"`
- `"Kimi-K2.7-Code"` → `"K2.7-Code"`
- `"Qwen3.5-397B-A17B"` → `"3.5-397B"`
- `"Qwen3.6-35B-A3B"` → `"3.6-35B"`
- `"qwen3.7-max"` → `"3.7-max"` (lowercase qwen prefix)
- `"deepseek-v4-flash"` → `"v4-flash"`
- `"deepseek-v4-pro"` → `"v4-pro"`
- `"MiniMax-M3"` → `"M3"`
- Unknown / custom model → returns `undefined` (no match on regex)

**9. Auth edge cases: empty key, whitespace key, null secrets**

Covers: `readWaferApiKey` and `inspectWaferApiKeyCredential` currently only test the "no apiKey field" path. Missing: empty string key, whitespace-only key, null secrets bag.

Why medium: The auth store is per-user, persisted to disk. Edge cases in credential inspection affect the "usable" flag shown in the provider login UI.

Approach:

- `inspectWaferApiKeyCredential({ tokenType: "api-key", apiKey: "" })` → `usable: false`
- `inspectWaferApiKeyCredential({ tokenType: "api-key", apiKey: "   " })` → `usable: false` (whitespace trimmed)
- `readWaferApiKey({ tokenType: "api-key", apiKey: "  wfr_test  " })` → `"  wfr_test  "` (not trimmed by read, only trimmed by inspect)
- `buildWaferApiKeyCredential("")` → `secrets.apiKey = ""`, `readWaferApiKey` returns `""`
- `waferApiKeyAuth.inspectCredential(null)` → `usable: false`

**10. Ad-hoc model capabilities + pricing fallback**

Covers: `registerWaferModel` for a non-builtin model uses `CAPS_GLM_5_1` as default capabilities and `PRICING_WAFER_GENERIC` (zero pricing). This path is only tested for registration, not for the fallback values.

Why medium: Ad-hoc models are the escape hatch for new models before the catalog is updated. Wrong fallback capability would break the agent for that model.

Approach: After `setup()`, register an ad-hoc model `"some-future-model"`, then verify:

- `resolveModel("some-future-model").capabilities` equals `CAPS_GLM_5_1` (or at minimum `contextWindow` and `thinking` fields)
- `resolveModel("some-future-model").pricing.inputUSD` is 0 (PRICING_WAFER_GENERIC)
- `resolveModel("some-future-model").vendorIds.firstParty` equals `"some-future-model"`

**11. registerWaferModels return value count**

Covers: `registerWaferModels()` returns an array of registered IDs. The test only checks that all 10 resolve correctly but never checks the return value.

Why medium: The return value is used by the bootstrap path. If it omits a model, that model silently never appears in the registry.

Approach: In the "registers all 10 built-in models" test, capture the return value: `const ids = registerWaferModels()` (call directly after clear), expect `ids.length` to be 10, expect `ids` to contain each model ID string.

**12. bootstrapWafer idempotency**

Covers: Calling `bootstrapWafer()` twice should not double-register models or the adapter. The current test only calls it once per `setup()`.

Why medium: The plugin registry calls `bootstrapWafer` at startup. If a plugin reload happens (config change), calling it again must be safe.

Approach: Call `bootstrapWafer()` twice, then verify model count is still 10 (not 20). Resolve a model, verify it still works.

**13. Model tags validation**

Covers: Each model's tags are set in `models.ts` but only `"balanced"` is verified in the test (via `resolveModel("GLM-5.1").tags`). The other tags like `"reasoning"`, `"cheap"`, `"scout"`, `"flagship"`, `"deep"`, `"vision"`, `"code"`, `"1m-context"` are never checked.

Why medium: Tags drive `recommendSubagentModels` and `findModelByTags`. Wrong tags → wrong sub-agent model selection.

Approach: Verify tags per model:

- GLM-5.1: `"reasoning"`, `"balanced"`
- deepseek-v4-flash: `"cheap"`, `"scout"`
- deepseek-v4-pro: `"flagship"`, `"deep"`
- Kimi-K2.6: `"vision"`
- Kimi-K2.7-Code: `"code"`
- MiniMax-M3: `"1m-context"`
- Qwen3.6-35B-A3B: `"cheap"`
- qwen3.7-max: `"flagship"`

### LOW (3 tests)

**14. ZDR header test (WAFER_ZDR_HEADER)**

Covers: The adapter.ts comment mentions setting `Wafer-ZDR` when the model advertises `zdr_supported`, but the actual header-setting logic is not in the current adapter (it's in a comment block only). Test that the wire constant exists and the header name is correct.

Why low: The header is not yet wired into the request path; it's in a comment. When it is wired, this test becomes HIGH.

Approach: Verify `WAFER_ZDR_HEADER` equals `"Wafer-ZDR"`. Verify `WAFER_BASE_URL`, `CHAT_COMPLETIONS_URL`, `MODELS_URL` constants.

**15. Model vendorIds.firstParty mapping**

Covers: The test verifies `m.vendorIds?.firstParty` for GLM-5.1 but not for any other model.

Why low: This is a structural identity field. It's tested for one model; the pattern holds for all.

Approach: Add vendorIds check to the "all 10 models" test loop, or spot-check 3-4 models (Qwen, DeepSeek, MiniMax).

**16. shortCode + displayName on waferProviderPlugin**

Covers: `waferProviderPlugin.shortCode = "wf"`, `waferProviderPlugin.displayName = "Wafer"`, `waferProviderPlugin.id = "wafer"`. The plugin surface fields are never verified beyond the adapter's `displayName`.

Why low: These are display-only constants. But they are part of the ProviderPlugin contract.

Approach: Verify `waferProviderPlugin.shortCode` is `"wf"`, `waferProviderPlugin.id` is `"wafer"`, `waferProviderPlugin.displayName` is `"Wafer"`.

## Comparison with peer test suites

### OpenRouter has but does NOT test (same gaps)
- parseOpenRouterQuotaWindows, parseOpenRouterResetMs (_exported, untested_)
- fetchOpenRouterSessionInfo, setOpenRouterRateLimits (_exported, untested_)
- taggedHttpError classification (_OpenRouter throws plain Error, no classification_)
- Model version token (_no equivalent function_)
- Session usage accumulation (_no equivalent_)

### OpenAI tests that Wafer should mirror
- `captureFailingNetwork` pattern for error classification on the run path (CRITICAL #1, HIGH #6)
- Error event tests with `stream_error` event type (CRITICAL #1)
- Fixture replay tests per surface (already covered by SSE pong test)
- Modality gating tests (HIGH #5, capability validation)
- Complete pricing table for all registered models (HIGH #7)

### Anthropic tests that Wafer should mirror
- `onStartupProbe` / prime pattern (HIGH #4)
- Individual model capability assertions (HIGH #5)
- modelVersionToken (MEDIUM #8 — Anthropic has the function but no explicit test)
- Auth edge cases (MEDIUM #9)

## Suggested implementation order

1. **First batch** (CRITICAL + HIGH, ~8 tests): error classification with fake network client, session-info unit tests (parse + set/get/clear + prime dedupe), capability validation for all 10 models, full pricing table
2. **Second batch** (MEDIUM, ~6 tests): modelVersionToken, auth edge cases, ad-hoc model fallback, registerWaferModels return value, bootstrap idempotency, model tags
3. **Third batch** (LOW, ~3 tests): ZDR constants, vendorIds, shortCode/displayName

Each batch should be implementable in ~30-60 minutes. The first batch is the highest-leverage: it covers the error paths the agent loop actually depends on.