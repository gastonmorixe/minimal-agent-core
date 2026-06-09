# Claude Fable 5 support (fix: unregistered model → silent neutral prompt → 429)

**Status:** shipped
**Owner:** agent (session 67c866c1)
**Scope:** `src/llm/pricing.ts`, `plugins/llm-anthropic/capabilities.ts`, `plugins/llm-anthropic/models.ts`, `src/client/list-models.ts`

## Symptom

Selecting `--model claude-fable-5` (the public Mythos-class model Anthropic
released 2026-06-09) made every request fail with:

```
HTTP 429  {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}
```

on every retry, with the agent hanging at 0 tokens. `./minimal-agent providers
models anthropic` *listed* `claude-fable-5`, so it looked available, which made
the 429 read like a capacity limit.

## Root cause

It was **not** a rate limit. It was our own request shape.

`claude-fable-5` showed up in the model picker because `listModels()`
(`src/client/list-models.ts`) fetches the live `GET /v1/models?beta=true`
catalog at display time. But the model was **never registered in the canonical
model registry** (`plugins/llm-anthropic/models.ts` had six static entries,
none of them Fable). The two lists are independent: one is a live display
fetch, the other is the compiled-in registry that drives request building.

At request time the gap surfaced through the system-prompt resolver
(`src/llm/system-prompt.ts`):

```ts
let providerId: string | undefined
try {
  providerId = resolveModel(modelId).providerId   // throws "unknown model claude-fable-5"
} catch {
  providerId = undefined                            // ← swallowed
}
const plugin = providerId ? findProviderPlugin(providerId) : undefined
const resolved = plugin?.resolveSystemPrompt
  ? plugin.resolveSystemPrompt(ctx)
  : neutralSystemPrompt(ctx)                         // ← neutral, NO Claude Code identity
```

`resolveModel("claude-fable-5")` threw, the `catch` set `providerId =
undefined`, the Anthropic plugin's `resolveSystemPrompt` was never called, and
the request went out with the agent's **neutral** system prompt instead of the
mandatory Claude-Code preamble.

Anthropic gates **plan / subscription OAuth tokens** to Claude Code: a request
on such a token MUST lead with, byte-exact,

```
system[0]  x-anthropic-billing-header: cc_version=<v>.<hash>; cc_entrypoint=cli; cch=00000;
system[1]  You are Claude Code, Anthropic's official CLI for Claude.
```

Without that preamble the server rejects the call as `rate_limit_error` (a
generic gate response, not a real bucket overflow). Opus 4.8 worked only because
it *was* registered, so its requests carried the preamble.

### Empirical proof

Direct `curl` with the user's OAuth token, holding everything else constant:

| Request | system[0] | Result |
| --- | --- | --- |
| `claude-fable-5`, neutral prompt | "You are Minimal Agent…" | **429** `rate_limit_error` (3/3) |
| `claude-fable-5`, Claude Code preamble | "You are Claude Code…" | **200**, `"FABLE OK and 391"` (3/3) |

The 429 carried **no** `retry-after` and **no** `anthropic-ratelimit-*`
headers, the tell that it was a synthetic gate, not a token bucket. The live
Claude Code 2.1.169 capture confirmed the working shape: real CC sends the
billing header + Claude-Code identity on its `claude-fable-5` turns and gets 200,
with rate-limit headers showing 12% / 11% utilization (nowhere near a limit).

The account is entitled to the model: the bootstrap probe returns
`client_data.cedar_lagoon: { "claude-fable": true, "claude-mythos": true }`, and
`/v1/models` lists `claude-fable-5` with full capabilities.

## The fix

Register `claude-fable-5` in the canonical registry so `resolveModel()`
resolves it, the Anthropic plugin's `resolveSystemPrompt` runs, and the
Claude-Code preamble is attached on plan auth, identical to every other
Anthropic model.

- **`src/llm/pricing.ts`** — new `ANTHROPIC_FABLE_5` rate: `$10 / 1M` input,
  `$50 / 1M` output, `$12.50` cache-write, `$1` cache-read (half the gated
  Mythos Preview's $25/$125). Single flat rate; Fable has no `speed:"fast"` tier.
- **`plugins/llm-anthropic/capabilities.ts`** — new `CAPS_FABLE_5`, mirroring
  Opus 4.8's request surface per the live `/v1/models` record (1M context, 128K
  max output, effort `low|medium|high|xhigh|max`, adaptive-only thinking,
  image + pdf input, structured outputs, code execution, full
  context-management) with `speedFast: false`.
- **`plugins/llm-anthropic/models.ts`** — `registerModel({ id:
  "claude-fable-5", … })` as the first/flagship entry, with the
  `claude-fable-5[1m]` alias, tags `["fable","mythos","1m-context","flagship",
  "production"]`, base `pricing: ANTHROPIC_FABLE_5` (no `pricingForRequest`
  picker, since there is no fast tier), and `vendorIds` across all surfaces.
- **`src/client/list-models.ts`** — `supports1M()` now matches
  `claude-fable-5`, so the synthesized `[1m]` variant shows in `--list-models`.

### Follow-up: 1M-context beta gate on the legacy transport

A second, pre-existing gap surfaced once Fable was usable (flagged by a parallel
review session). `src/headers.ts` `buildBetaFlags()` gated the
`context-1m-2025-08-07` beta on `/[1m]/ || model.includes("opus")`. Plain
`claude-fable-5` (no `[1m]` suffix) matched neither, so the **legacy transport**
(still used by `Agent.send` / `Agent.run` via `client.ts`) never sent the 1M
beta and long Fable sessions would 400 once they grew past ~200k. The canonical
transport was already correct (it gates on `capabilities.contextWindow >=
1_000_000`).

Fixed by replacing the `opus` substring with an explicit 1M-native family list
that mirrors the canonical capability test: opus 4.6/4.7/4.8, sonnet 4.6, and
fable-5. This also closes a latent twin gap, **`claude-sonnet-4-6` is 1M-native
and was missing the flag too**. A bare `"sonnet-4"` substring was deliberately
avoided so the 200k `sonnet-4-5` / `haiku` stay excluded. The registry isn't
readable from this low-level module (import-cycle risk + late plugin
activation), which is why the families are enumerated as strings rather than
read from `capabilities`. Added three `headers.test.ts` cases (fable-5 positive,
sonnet-4-6 positive, 200k-models negative).

## Why this is the right layer

The model was already *displayable* but not *buildable*. The honest fix is to
make the registry agree with the live catalog, not to special-case the system
prompt. Once the model resolves to the `anthropic` provider, the existing,
tested `resolveAnthropicSystemPrompt` path does exactly the right thing on both
OAuth (preamble) and API-key (neutral) auth, with no new branching.

A defensive follow-up worth considering separately: the silent `catch` in
`resolveSystemPrompt` masks *any* unregistered model as a neutral-prompt 429.
Logging a warning there would turn the next "available but unregistered" model
from a silent gate into an obvious diagnostic. Left out of this change to keep
it scoped to Fable.

## Verification

- `bun x tsc --noEmit` — clean (no duplicate-symbol / type errors).
- Targeted suites (`plugins/llm-anthropic`, `model-registry`, `system-prompt`,
  `pricing`): **116 pass / 0 fail**.
- `headers.test.ts` after the 1M-gate fix: **47 pass / 0 fail** (incl. the 3 new
  context-1m cases).
- Full `bun run check` — green.
- Live: `claude-fable-5` returns **200** through the harness path with the
  Claude-Code preamble attached (was 429 on every attempt before).
