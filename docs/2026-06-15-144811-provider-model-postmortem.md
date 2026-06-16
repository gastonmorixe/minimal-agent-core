---
title: Provider and model integration postmortem
created_at: "2026-06-15T14:48:11.609739000-0400"
updated_at: "2026-06-15T14:48:11.609739000-0400"
session_id: "019ec3a9-3bc3-7963-bfe6-e4903b8185e6"
host_info:
  hostname: macbookpro.home.arpa
  user: gaston
  os: "macOS 27.0 (26A5353q)"
  kernel: "27.0.0"
  arch: arm64
  serial: FHQ93DD9T6
tags: [postmortem, providers, models, auth, testing]
taillog:
  - "2026-06-15T14:48:11.609739000-0400 | Initial postmortem on provider/model integration failures and test coverage gaps"
---

# Provider and model integration postmortem

## Summary

The provider/model work took too long because the project had a large test suite, but the tests mostly proved that existing pieces kept behaving as previously described. They did not prove the product-level contract that mattered:

```sh
ma --model="gpt-5.5" --provider=openai
```

must select the OpenAI provider, use the right stored OpenAI credential, hit the right OpenAI runtime endpoint for that credential type, send a valid request body for that endpoint, stream a response through the canonical transport, and fail quickly when the server reports a deterministic request error.

That end-to-end contract was not covered. As a result, multiple agents could make locally reasonable changes, pass thousands of tests, and still leave the actual user path broken.

The final fix required treating this as a product bug, not only an architecture bug. The OpenAI plugin now routes ChatGPT OAuth Responses traffic to the Codex backend path, sends the OAuth metadata headers, normalizes the request body required by that backend, preserves the public API-key path separately, and stops retrying deterministic request failures forever.

## What actually failed

The visible failure was:

```text
ma --model="gpt-5.5" --provider=openai
...
not_found_error: retrying attempt 2
```

The first root cause was endpoint selection. OpenAI API-key traffic uses:

```text
https://api.openai.com/v1/responses
```

ChatGPT OAuth plan traffic uses:

```text
https://chatgpt.com/backend-api/codex/responses
```

The plugin was building:

```text
https://chatgpt.com/backend-api/codex/v1/responses
```

That produced the misleading `not_found_error`.

After fixing the path, the live backend exposed more request-shape differences:

- `instructions` is required by the ChatGPT Codex backend, even when empty.
- `store` must be `false`.
- `max_output_tokens` is rejected by that backend, even though the public Responses API accepts it.
- Provider-owned OAuth headers such as `ChatGPT-Account-ID` were decoded from credentials but not actually sent.

The retry layer then made debugging worse. It treated `not_found_error` and `invalid_request_error` as retryable slow-curve failures. That converted deterministic programming/configuration errors into long-running hangs, exactly the opposite of what the login and model-selection path needs.

## Why 5k+ tests did not catch it

### 1. The suite was broad, but not contract-complete

The repository had thousands of tests, but the missing test was simple:

```text
Given provider=openai, model=gpt-5.5, auth=OpenAI OAuth,
the first runtime request must be POST https://chatgpt.com/backend-api/codex/responses
with the required OAuth backend body shape and auth metadata headers.
```

There were tests for translators, registries, bootstrapping, auth codecs, and generic retry behavior. There was no focused adapter test that captured the outgoing network request for the exact OAuth Responses path.

The suite had many unit-level facts. It lacked the one integration-level fact that connected them.

### 2. Too many tests were characterization tests of old behavior

Some tests did not encode desired behavior. They encoded the historical behavior, including bad behavior.

The retry tests explicitly expected `invalid_request_error` to retry forever on the slow curve. That made sense under an old "never give up" harness philosophy, but it was wrong for malformed request bodies and model/endpoint errors. When the live smoke hit `{"detail":"Instructions are required"}`, the agent entered slow retry instead of surfacing the real error immediately.

This is the central testing lesson: a test suite can be large and green while still defending the wrong invariant.

### 3. Provider decoupling was tested more strongly than provider correctness

The architecture ratchets were useful. They prevented new provider names in core and forced cleanup of core provider coupling. But that kind of test answers:

```text
Is provider-specific code outside core?
```

It does not answer:

```text
Does this provider plugin send the correct request for each auth mode?
```

The decoupling work was necessary, but it became the dominant success metric. Agents could satisfy the architecture tests while leaving the real provider runtime path broken.

### 4. The provider abstraction had a missing dimension: auth mode changes the endpoint contract

The code treated "OpenAI Responses" as one surface with one path shape. That was incomplete.

The actual dimensions are:

- provider id
- model id
- surface id
- auth kind
- endpoint family
- wire request body variant

For OpenAI, API-key Responses and ChatGPT OAuth Responses are similar but not identical. They share model ids and stream event shapes, but they do not share the exact URL path or accepted request fields.

The abstraction captured provider and surface, but not enough of the endpoint-family distinction. That let the adapter append the public `/v1/responses` path to an OAuth backend base URL.

### 5. The old and new transports coexist, increasing cognitive load

The repo still has a legacy client and the canonical provider path living side by side. That coexistence is explicitly documented and intentional, but it makes failures harder to reason about.

Agents had to keep track of:

- legacy client behavior
- canonical adapter behavior
- shared retry behavior
- plugin auth behavior
- provider discovery and model registry behavior
- startup selection behavior
- TUI/non-interactive behavior

The final bug lived in the plugin adapter, but the symptom surfaced in the TUI retry renderer. The fix touched both provider plugin code and provider-neutral retry classification. That is a lot of surface area for one user-visible failure.

### 6. The live smoke was missing until the end

The decisive step was running a minimal live command:

```sh
MINIMAL_AGENT_NO_PLUGIN_SYNC=1 ./minimal-agent \
  --model="gpt-5.5" \
  --provider=openai \
  --mode none \
  --no-header \
  --prompt "Reply exactly: pong"
```

Before that, local tests could only infer correctness. The live smoke proved the endpoint fix was incomplete, revealing the missing `instructions`, `store:false`, and unsupported `max_output_tokens` behavior.

The lesson is not that every test must be live. The lesson is that when implementing an auth/provider integration, at least one minimal live smoke should be part of the acceptance criteria before declaring success.

## Why many agents made slow progress

The agents were solving overlapping but different problems:

- login UX and abortability
- OAuth/API-key storage
- provider-free core architecture
- model/provider selection semantics
- startup defaults
- TUI behavior
- OpenAI/Anthropic/OpenRouter plugin behavior
- retry behavior

Each subproblem had legitimate complexity. The slowdown came from not forcing a single acceptance path early enough:

```text
Fresh process -> provider discovery -> explicit provider/model -> stored credential -> adapter request -> live backend -> streamed response.
```

Without that acceptance path, each agent optimized a local region:

- one agent made provider discovery cleaner
- one agent removed core provider fallbacks
- one agent improved login storage
- one agent fixed command parsing
- one agent improved tests
- one agent reviewed architecture drift

Those were useful, but none of them alone proved that `ma --model="gpt-5.5" --provider=openai` worked.

## What changed in the fix

The final patch changed 12 files:

```text
plugin-api/src/llm/errors.ts
plugins/llm-openai/adapter.ts
plugins/llm-openai/headers.ts
plugins/llm-openai/openai.test.ts
plugins/llm-openai/responses/request-body.ts
plugins/llm-openai/wire-constants.ts
src/architecture/provider-baseline.ts
src/client.errors.test.ts
src/client.ts
src/llm/errors.test.ts
src/llm/transport/retry.test.ts
src/llm/transport/retry.ts
```

Behavioral changes:

- OAuth Responses requests now use `/backend-api/codex/responses`.
- API-key Responses requests still use `/v1/responses`.
- OAuth headers owned by the provider credential are sent.
- Responses bodies always include `instructions`.
- Responses bodies default to `store:false`.
- OAuth Responses requests force `store:false`.
- OAuth Responses requests strip `max_output_tokens`.
- `400`, `403`, and `404` upstream failures are terminal.
- `429` rate limits still retry on the slow curve.
- transient network and server failures still retry.

## What the new tests cover

The new regression tests assert:

- OpenAI OAuth Responses traffic routes to `https://chatgpt.com/backend-api/codex/responses`.
- API-key Responses traffic routes to `https://api.openai.com/v1/responses`.
- OAuth request headers include provider-owned auth metadata.
- OAuth request bodies include `instructions`, `store:false`, and omit `max_output_tokens`.
- API-key request bodies keep `max_output_tokens`.
- `not_found_error` no longer retries.
- `invalid_request_error` no longer retries.
- rate-limit errors still retry.
- the provider-token ratchet was tightened because `src/llm/errors.test.ts` no longer contains provider tokens in code.

## Verification performed

Focused tests:

```sh
bun test plugins/llm-openai/openai.test.ts \
  src/llm/errors.test.ts \
  src/llm/transport/retry.test.ts \
  src/client.errors.test.ts
```

Result:

```text
65 pass
0 fail
```

Live smoke:

```sh
MINIMAL_AGENT_NO_PLUGIN_SYNC=1 ./minimal-agent \
  --model="gpt-5.5" \
  --provider=openai \
  --mode none \
  --no-header \
  --prompt "Reply exactly: pong"
```

Result:

```text
pong
```

Full gate:

```sh
bun run check
```

Result:

```text
5133 pass
11 skip
0 fail
```

## Design lessons

### Test the provider contract at the adapter boundary

Every provider plugin needs tests that capture the exact outbound request for each supported auth mode. For OpenAI, that means API key and OAuth are separate cases. For OpenRouter or other compatible gateways, gateway auth and first-party auth should also be separate cases.

The adapter boundary is the right test level: no live network required, but the URL, headers, body, and selected model are observable.

### Treat auth kind as part of the wire contract

`provider + surface` was not enough. The auth kind can change endpoint family and accepted fields. The provider plugin should own that distinction explicitly.

Core should not know "OpenAI OAuth" or "ChatGPT Codex backend". Core should pass opaque `ProviderAuth`; the plugin should convert it into the correct URL, headers, and body.

### Do not retry deterministic request errors

Retrying forever is correct for network errors, truncated streams, overload, and rate limits. It is wrong for malformed requests, missing endpoints, missing permissions, and missing models.

The right split is:

- retry: transient network, stream timeout/truncation, overload, rate limit
- fail immediately: invalid request, permission denied, not found, billing/quota exhaustion, auth failure after refresh

This makes bugs visible. It also makes Ctrl-C less important because the agent is no longer stuck in avoidable slow retry loops.

### Architecture ratchets are necessary but insufficient

The provider-free core ratchet is important and should stay. It catches a class of regression that would otherwise grow silently.

But architecture ratchets should be paired with behavior ratchets. A clean boundary is not enough if the plugin behind the boundary sends the wrong bytes.

### Live smoke should be a release criterion for new provider/auth paths

Most tests should stay offline. But after implementing or changing a provider auth path, one minimal live smoke is the only reliable way to discover undocumented backend requirements.

The live smoke should be cheap, explicit, and documented. It should not be part of `bun run check`, but it should be part of the human acceptance checklist.

## Recommended follow-up work

1. Add a documented provider acceptance checklist under `docs/` or `private/research/`.
2. Add adapter-boundary tests for every provider/auth pair:
   - provider id
   - auth kind
   - selected model
   - expected URL
   - required headers
   - forbidden request fields
   - required request fields
3. Add a non-live smoke command script that uses fake network clients to exercise startup -> adapter dispatch.
4. Add an optional live smoke target gated by an environment variable for each provider.
5. Audit existing retry classifications and make every retryable tag justify how it can recover without a code/config/auth change.
6. Keep shrinking the legacy provider-token baseline, but do not confuse baseline shrinkage with provider correctness.

## Bottom line

The core agent was not working because the test suite proved many pieces, but not the actual provider/model/auth path the user ran. The architecture work moved provider-specific code into plugins, but the OpenAI plugin still encoded the wrong endpoint contract for OAuth. The retry system then hid deterministic errors behind slow retry loops.

The fix was to test and repair the real contract: explicit provider plus model, stored provider auth, correct provider-owned URL/header/body translation, immediate surfacing of deterministic errors, and a live smoke that proves the command actually completes.
