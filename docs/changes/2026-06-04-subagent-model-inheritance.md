# Sub-agent workers inherit the lead's model by default (no silent downgrade)

**Date:** 2026-06-04
**Scope:** `plugins/sub-agents/lib/handler-deps.ts`, `plugins/sub-agents/lib/runtime.ts`, `plugins/sub-agents/lib/service.ts` (comment), `plugins/sub-agents/lib/library.ts` (comment), `plugins/sub-agents/manifest.json` (tool description), `plugins/sub-agents/PROMPT.md`; new tests in `handler-deps.test.ts` and `runtime.test.ts`.

## Problem

Delegating to a built-in specialist while running Opus silently launched the worker on a cheaper model. Spawn `explorer` and it ran on Haiku; spawn `worker`, `planner`, or `integrator` and it ran on Sonnet. The user never asked for that and got no signal it happened.

The cause was the model-precedence order in `service.ts`:

```
per-spawn model  →  definition's pinned model  →  provider role recommendation  →  lead's model
```

Every built-in specialist carries an abstract `role` (`scout` / `balanced` / `deep`). The Anthropic provider's `recommendSubagentModels` maps those tiers to concrete SKUs: scout → Haiku, balanced → Sonnet, deep → Opus. Because the role recommendation sat AHEAD of the lead's own model, any role-bearing specialist resolved to the tier SKU before the lead's model was ever consulted. The "inherit the lead's model" rung was effectively dead for the built-in specialists, which is most spawns.

This also fed the deliverable-failure complaints. The library's own `log-miner` comment already noted that a low-effort/cheap worker drowns on large forensic corpora and conflates other sessions' content with its own task. Handing balanced (Sonnet) or scout (Haiku) workers deep work, with no way for the user to see the downgrade, made `incomplete · no deliverable` outcomes more likely, not less.

## Design

The role-recommendation rung is now **opt-in**, off by default.

- New `resolveAutoTier(env)` in `runtime.ts` reads `MINIMAL_AGENT_SUBAGENT_AUTO_TIER`. True only for the exact value `"1"`.
- `makeRecommendForRole` in `handler-deps.ts` returns `undefined` (so the service falls through to the lead's model) unless auto-tiering is on. The existing env-override short-circuit and the "host wired no provider" case still apply.
- `service.ts` is unchanged in behavior: when `recommendForRole` is undefined the precedence naturally collapses to `per-spawn model → pinned model → lead's model`. Only the explanatory comment changed.

Resulting precedence (default):

```
per-spawn model  →  MINIMAL_AGENT_SUBAGENT_MODEL  →  lead's live model  →  omit --model (child self-resolves)
```

Resulting precedence (with `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1`):

```
per-spawn model  →  MINIMAL_AGENT_SUBAGENT_MODEL  →  provider role recommendation  →  lead's live model
```

An explicit per-spawn `model` and the `MINIMAL_AGENT_SUBAGENT_MODEL` env override both still win in either mode, so a user who wants cheap scouts can opt in and still pin a model for a specific spawn.

### Why off by default

The user is paying for the model they selected. A delegated unit of work is still the user's work and should run on the user's model unless the user says otherwise. Guessing "cheaper is fine" is a cost decision that belongs to the user, not the tool. Auto-tiering stays available for anyone who wants it, behind one explicit flag.

## Doc / prompt fixes shipped alongside

- `manifest.json`: the `model` param description (read by the lead at every spawn) claimed specialists "lean to a fast cheap model, NOT necessarily yours." Rewritten to state workers inherit the lead's model, with the opt-in noted. Removed the em-dash.
- `PROMPT.md`: dropped "often `explorer` on a cheap model."
- `library.ts` / `service.ts`: corrected the comments that described the cheap default as intended.
- `prompts/result-protocol.tmpl.md`: unwrapped the hard-wrapped (~80 col) paragraphs to one line each. This template ships to every worker on every spawn; the hard newlines were wasted wire tokens. Markdown renders identically.

## Tests

- `runtime.test.ts`: `resolveAutoTier` is off by default and on only for `"1"`.
- `handler-deps.test.ts` (new): `serviceDepsFromCtx` does NOT wire `recommendForRole` by default (worker inherits `defaultModel`); wires it only under `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1`; an explicit env model override still suppresses it.
- The existing `service.test.ts` role tests are unchanged: they inject `recommendForRole` directly to test the service layer in isolation, which is correct. The gating lives one layer up, in `handler-deps`.

35 tests pass across the touched files; full typecheck clean.
