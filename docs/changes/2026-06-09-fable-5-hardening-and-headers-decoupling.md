# Fable-5 hardening + headers.ts decoupling (Waves 0-1)

**Date:** 2026-06-09
**Commits:** `97c0191`, `86a464b`, `1bf4ffa`, `a24d715`, `b7bdceb`, + Phase-8 JSDoc/exhaustiveness fix
**Context:** Follow-up to `2026-06-09-anthropic-fable-5.md` (the registration
commit `27f5227`). A 10-track audit of that change surfaced two P0s, a set of
P1/P2s, and a structural diagnosis of `src/headers.ts`. This doc records the
fixes and the start of the decoupling refactor.

## Audit verdicts (10 parallel tracks)

Two P0s, both fixed same-day:

1. **Duplicate `ANTHROPIC_FABLE_5` declaration** (`src/llm/pricing.ts`) from a
   3-way edit collision. Syntax-level failure: the whole module graph refused
   to load, which also crashed every spawned sub-agent at boot (they run
   minimal-agent from this repo's source). Fixed in `27f5227`.
2. **Plain `claude-fable-5` missed the `context-1m-2025-08-07` beta** on the
   default legacy transport: the gate was `/\[1m\]/ || includes("opus")`.
   Long sessions would 400 past ~200k while compaction (fed 1M from the
   registry) never fired. Fixed in `97c0191` with an explicit 1M-family list
   (also closing the latent sonnet-4-6 twin gap) + 3 regression tests.

## Fast-mode capability gate (`86a464b`)

The legacy transport sent `speed:"fast"` + the `fast-mode-2026-02-01` beta
ungated (a sticky `--fast`/`MINIMAL_AGENT_FAST=1` from an opus session meant
429 on every request against fable/sonnet/haiku). `sendMessageOnce` now
consults `findModel(rawModel)?.capabilities.speedFast` and drops both the body
field and the header with a `diag.warn` when unsupported, matching the
canonical transport. Unregistered ids stay un-gated (server decides).
SessionInfo's `fast:` line is fixed twice over: the host mirrors the RESOLVED
fast state into `MINIMAL_AGENT_FAST` (the CLI flag never wrote the env before,
so `--fast` sessions read as not-fast), and the snapshot cross-checks the
model capability so it never claims a tier the model lacks.

Wire-level pins: a no-fast model drops body+header; a fast-capable model keeps
both (synthetic registry entries, no plugin bootstrap dependency). Catalog
pins: flat $10/$50 rate, no `pricingForRequest`, `speedFast:false`, 1M/128k,
xhigh effort, `[1m]` alias resolution.

## Display + docs polish (`1bf4ffa`)

`modelShortLabel("claude-fable-5")` → `anth-5` (family regex gained `fable`
and an optional minor digit); fleet widget tier words gained `fable`; README
model table + fast-mode footnote; CHANGELOG entries; pricing comment math
corrected ($10/$50 is 0.4x of $25/$125, not half) and the deliberate
FABLE_5/OPUS_48_FAST value-twin documented; `headers.ts MODELS` docstring
stopped claiming to be the latest-models capture (it is the legacy tier-id
map feeding `DEFAULT_MODEL`); `capabilities.ts` header notes CAPS_FABLE_5
derives from the live 2026-06-09 `/v1/models` record, not the old cjs gates.

## Decoupling Wave 0: characterization suites (`a24d715`)

Two new test files pin CURRENT wire behavior so later waves prove "no
unintended change" mechanically:

- `src/headers.characterization.test.ts`: legacy `buildBetaFlags` pinned
  per model as ordered arrays; quota/title probe sets; the auth split with
  the api-key zero-beta gap pinned AS a known gap (B2); fast-mode
  caller-trust; stainless fingerprint.
- `plugins/llm-anthropic/beta-flags.characterization.test.ts`: canonical
  per-model sets; the in-builder speedFast gate; and a cross-transport
  divergence CONTRACT (redact-thinking + api-key divergences asserted
  explicitly; agreement walks for context-1m and interleaved-thinking across
  every registered model, the drift class behind the fable P0).

## Decoupling Wave 1: neutral extraction (`b7bdceb`)

Zero-behavior-change moves with back-compat shims:

- Reflection-checkpoint defaults → `src/agent/reflection.ts` (agent-loop
  config, not wire constants). `headers.ts` re-exports until Wave 4.
- `plugins/memory` no longer imports `MODELS` from `src/headers.ts`. New
  `defaultSummaryModel()` resolves the cheap tier from the model registry by
  tags with an early-boot literal fallback.

## Phase 8: mechanical headers.ts repairs

- B10: the malformed nested `/**` at the `buildBetaFlags` doc (an unclosed
  table comment swallowing the function doc, plus a `\"conversation"` escape
  typo) merged into one well-formed JSDoc; the stale "context-1m is
  opus-only" claim replaced with the current 1M-family description.
- B11: the unreachable post-switch `return buildBetaFlags("conversation",
  model)` (which would have dropped `betaOpts` if ever reached from untyped
  JS) replaced with `return requestType satisfies never`, making the switch
  exhaustiveness compiler-checked.

## Open items (deliberately NOT done here)

- **B1 (needs a live probe):** sonnet-4-6 now gets `context-1m` on the legacy
  transport (97c0191). Pre-overage accounts historically 429'd on sonnet long
  context. If that gating still exists server-side, default-config Pro users
  could hit it; `parseModelUnavailableError` catches the error shape and
  reopens the picker, so the failure is soft. Settle with one long-context
  probe on a non-overage account before Wave 2 locks in unified behavior.
- **Wave 2+:** single beta-flag source (legacy delegates to the canonical
  builder via registry lookup), api-key flag-set decision, redact-thinking
  policy unification, transport flip, headers.ts dissolution.
- **Interleaved-thinking on fable-5:** fable is opus-4.8's capability twin
  and DOES receive the interleaved-thinking beta (the 4.8 pathology gate is
  id-specific). Needs a wire test to confirm fable doesn't share the
  tool-batch spiral; extend the gate if it does.
- **vendorIds provenance:** fable's bedrock/vertex/mantle ids are
  extrapolated, unverified (inert today: nothing consumes them).
