---
title: "Claude Sonnet 5 support + Anthropic ad-hoc model registration"
status: shipped
date: 2026-06-30
author: Jack (session efbc0180)
scope:
  - plugins/llm-anthropic/pricing.ts
  - plugins/llm-anthropic/capabilities.ts
  - plugins/llm-anthropic/models.ts
  - plugins/llm-anthropic/adapter.ts
  - plugins/llm-anthropic/beta-gates.ts
  - plugins/llm-anthropic/list-models.ts
  - plugins/llm-anthropic/index.ts
  - plugins/llm-anthropic/pricing.test.ts
  - plugins/llm-anthropic/adhoc-model.test.ts
  - plugins/llm-anthropic/anthropic.test.ts
  - src/effort-resolution.ts
tags: [anthropic, models, pricing, capabilities, sonnet-5]
---

# Claude Sonnet 5 + Anthropic ad-hoc models

Two related changes prompted by `claude-sonnet-5` launching 2026-06-30 and the
session failing with `fatal: unknown model "claude-sonnet-5"`.

## Part 1: catalog `claude-sonnet-5` (the right fix for a known SKU)

Anthropic released Claude Sonnet 5 on 2026-06-30: most-agentic Sonnet,
performance near Opus 4.8, updated tokenizer. Source:
https://www.anthropic.com/news/claude-sonnet-5.

### Pricing (date-gated)

The launch post is explicit: introductory **$2/M input, $10/M output** through
**August 31, 2026**, then standard **$3/M input, $15/M output**.

- `pricing.ts`: new `ANTHROPIC_SONNET_5_INTRO` ($2/$10, standard cache
  multipliers $2.50 write / $0.20 read). The post-intro rate reuses the
  existing `ANTHROPIC_SONNET_STANDARD` ($3/$15).
- `models.ts`: a pure, exported `sonnet5RateForDate(nowMs)` returns intro before
  `2026-09-01T00:00:00Z` and standard on/after. The model's
  `pricingForRequest` picker calls it. Modeling the cutover as a date-gated
  picker (the same mechanism Opus 4.8 uses for `speed:"fast"`) means the bill
  auto-corrects on Sept 1 with no code change. The boundary is unit-tested so
  it can't silently drift.

### Capabilities

- `capabilities.ts`: new `CAPS_SONNET_5`, mirroring Sonnet 4.6's request surface
  (1M context, 64K max output, adaptive-only thinking, no `speed:"fast"`,
  image+pdf, full tools+caching) with one documented difference: the launch
  cost-performance charts plot Sonnet 5 at an `xhigh` effort level, so the
  effort ladder is `low|medium|high|xhigh` (vs Sonnet 4.6's `low|medium|high`),
  default `medium`.

### Registration + family gates

- `models.ts`: `register({ id: "claude-sonnet-5", ... })` with the
  `claude-sonnet-5[1m]` alias, tags `["sonnet","1m-context","flagship",
  "production"]`, full `vendorIds`. Inserted ahead of Sonnet 4.6, so the
  Anthropic provider's `balanced` sub-agent role now resolves to the newest
  Sonnet (test updated accordingly in `anthropic.test.ts`).
- The two id-based 1M-context fallback gates were extended to include
  `sonnet-5`: `beta-gates.ts` `wants1mContext` and `list-models.ts`
  `supports1M`. (Both prefer the registry; the string lists only matter for
  unregistered/early-boot ids, but completeness avoids a latent long-context
  400 like the Fable 5 incident.)
- `src/effort-resolution.ts`: doc comment updated to list sonnet-5 under
  `low/medium/high` and `xhigh` (documentation only; effort is validated
  against the model's declared levels).

## Part 2: Anthropic `registerAdHocModel` (general answer to "why hardcoded?")

The user's deeper question: why must every model be hardcoded? It need not. The
host already calls `plugin.registerAdHocModel?.(modelId)` before throwing
"unknown model" (`src/index.ts`), and four providers (ollama, openrouter,
opencode, wafer) implement it. The Anthropic plugin did not, which is the only
reason `claude-sonnet-5` hard-failed instead of booting with sane defaults.

- `adapter.ts`: `registerAnthropicAdHocModel(modelId)` now implements the hook.
  It captures the host `ModelRegistrar` at `bootstrapAnthropic` time (mirroring
  ollama) and falls back to a direct-registry adapter on the legacy no-context
  activation path.
- `models.ts`: `registerAnthropicAdHocModelInto(registrar, modelId)` synthesizes
  an entry whose capability + pricing profile is inferred from the id's family
  token (opus -> Opus 4.8 caps + $5/$25; haiku -> Haiku caps + $1/$5; fable/
  mythos -> Fable caps; default/sonnet -> Sonnet 5 caps + intro rate). It strips
  a `[1m]` suffix to the bare canonical id and re-adds it as an alias, tags the
  entry `adhoc`, and suffixes the display name `(ad-hoc)` so it is visibly
  distinct from a first-class catalog entry.

Effect: a future Claude SKU announced after this build boots immediately with
`--model <new-id>` (family-appropriate defaults) instead of hard-failing. A
model that warrants exact pricing/caps still gets a real catalog entry (Part 1).

### Why keep doing Part 1 if Part 2 exists?

The ad-hoc path bills at a GUESSED family rate and uses GUESSED capabilities.
For a real paid Anthropic account that is worse than for proxy gateways, so a
known production SKU like Sonnet 5 deserves the accurate, dated pricing and the
exact effort ladder. Part 2 is the safety net; Part 1 is correctness.

## Verification

- `bun test plugins/llm-anthropic`: 165 pass / 0 fail (incl. new
  `pricing.test.ts` date-gate cases and `adhoc-model.test.ts` family cases).
- Smoke: `claude-sonnet-5` resolves with 1M context, `xhigh` effort, the `[1m]`
  alias, and the $2/$10 intro rate today; ad-hoc `claude-opus-5-0` /
  `claude-haiku-5` / `claude-sonnet-6` synthesize with the right family caps and
  pricing.
- All provider + llm-core suites: 528 pass / 0 fail / 4 skip (live, gated).
