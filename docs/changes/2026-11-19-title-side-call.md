# Side calls for plugins and the session title record

Date: 2026-11-19. Scope: core (plugin host, plugin-api types, session tokens,
session index and catalog, model info, Anthropic request mapper). Users: the
new `ma-title-plugin` (plugins repo) and the CLI `sessions` command.
Design: `research/title-plugin/SPEC.md` §3 (P0 core).

## The problem

A plugin could not make a small, cheap model call of its own. `llm.complete`
gave text only, with no schema, no usage and no stop reason. It retried with
no limit and its timeout did not stop the request. Its usage went into the
session counters, so a side call added a turn and moved the context bar.
Event handlers had no host. No plugin could write session metadata, and no
plugin knew the run mode (REPL, one-shot, sub-agent). `prompt.submitted` did
not tell if the user typed the text or if a command expanded it.

## The contract

- **`host.llm.request(req)`** (capability `llm:complete`, additive;
  `LlmCompleteApi.request?`). Request `LlmSideRequest`: the
  `LlmCompleteRequest` fields plus `purpose` (`"title" | "summary" | "aux"`,
  default `"aux"`), `outputSchema {name, schema, strict?}` (maps to
  `outputConfig.format` json_schema), `thinking` (`"off" | "default"`),
  `effort` (`"low" | "medium" | "high"`), `abortSignal`, `maxUsdPerMTokIn`,
  `allowOtherProvider`. Result `LlmSideResult`: `text`, `json?`,
  `stopReason`, `model`, `provider`, `usage`, `costUsd?`, `latencyMs`,
  `reason?` (`LlmSideReason`), `detail?`. Implementation:
  `src/plugins/host/providers/llm-side.ts`.
  - It never throws. Each failure is a result with `stopReason` `error`,
    `timeout` or `aborted`, and a `reason`.
  - One attempt only (`canonicalAttemptFn`, no `withRetry`). One abort signal
    joins the timeout (default 10 000 ms), the caller signal and the host
    shutdown signal (`hostOptions.shutdownSignal`). The transport gets it.
  - `purpose: "title"` needs `model`. There is no fallback to the default
    model (`reason: "no-model"`, no send).
  - Price ceiling: `maxUsdPerMTokIn` (default 1.0 for `title`) against
    `ModelEntry.pricing.inputUSD`. A model with no known price fails
    (`unknown-price`). A price of 0 (subscription, local) passes.
  - Provider rule: the model must have the session provider (scope target,
    else `RunModeFact.providerId`, else the provider of the default model),
    unless `allowOtherProvider: true` (`reason: "other-provider"`).
  - The wire `requestType` stays `"title"` for all side purposes.
    `RequestType` (`src/llm/transport/types.ts`) has no change.
- **Anthropic thinking off** (`plugin-api/src/llm/anthropic-request.ts`):
  `thinking: {mode: "off"}` sends `{type: "disabled"}` only for a title
  request on an adaptive model with a wire effort of `high` or lower. Main
  turns keep the same wire body as before. An explicit `effort` goes through.
- **Aux usage** (`src/session/session-tokens.ts`): `runAsAuxUsage(meta, fn)`
  opens an `AsyncLocalStorage` frame. In the frame, `addSessionUsage` and
  `addSessionEstimatedUsage` call `addAuxUsage` and do not change `turns` or
  `contextSize`. New: `AuxUsageEntry`, `AuxUsageTotals`, `AuxUsageMeta`,
  `SessionTokenCounter.addAuxUsage` / `auxTotals`, `currentAuxUsageFrame`,
  `getAuxUsageTotals`. `llm.request()` and `llm.complete()` run in a frame,
  so ma-memory side calls also go to aux now.
- **Host in event handlers**: a manifest event subscription can set
  `"host": true` (`ManifestEventSubscription.host?`). Then a module handler
  gets `ctx.host`: the same capability-scoped host as tools and commands
  (default deny). Subprocess handlers get no host. The loader warns for
  `"host": true` on a high-frequency channel (`editor.key`,
  `editor.buffer.changed`, `prompt.input.changed`).
- **Run mode**: `EventHandlerContext.run?: RunModeFact`
  (`{mode, interactive, subagent?, providerId?, dryRun?}`, `RunMode` =
  `"repl" | "one-shot" | "stream-json" | "host" | "subagent"`). The host
  gives it with `PluginLoaderOptions.runMode`. A sub-agent env
  (`MINIMAL_AGENT_SUBAGENT_ID` or `_SID`) always gives `subagent`
  (`resolveRunModeFact`).
- **`prompt.submitted` source**: `PromptSubmittedPayload.source?:
  PromptSource` (`"user" | "command" | "expand" | "recovery" | "continue"`).
  The host sets it at each emit site. An old host sends no `source`.
- **`sessions:meta`** (new capability token): `host.sessionMeta` with
  `getTitle(sid)` and `setTitle({sid, title, source, model?, provider?,
  usage?})`. Each call takes an explicit sid. Core checks it first: a safe
  id, a sid that this process owns (scope sid, process sid, or
  `isOwnedSession`), and a session file. Else it throws `SessionMetaError`
  with no write. `setTitle` sanitizes, caps at 80 chars, rejects an empty
  title, and writes no `ai` title when a user title exists.
- **Title record** in the sidecar `index-meta.jsonl`:
  `{kind: "title", v: 1, sid, title, source: "ai" | "user" | "derived",
  model?, provider?, usage?, at}` (`IndexTitleRecord`, `isIndexTitleRecord`,
  `INDEX_TITLE_VERSION = 1`, `TITLE_MAX_CHARS = 80`). New helpers in
  `src/session/session-title.ts`: `sanitizeTitle`, `appendIndexMeta` (one
  O_APPEND line, never `index.jsonl`), `parseTitleState`, `readTitleState`.
  The session JSONL file has no change.
- **Readers**: `ParsedSessionIndex.titles` (`Map<sid, SessionTitleState>`).
  The last line wins per sid and source. A sidecar tombstone removes the
  earlier title lines of its sid. An `index.jsonl` tombstone with no later
  session line also removes them. An empty last `user` line means "no user
  title". A line with an unknown `v` is ignored.
- **Catalog**: `SessionCatalogRow.title?` and `titleSource?`. Display order:
  user, then ai, then derived. `summary.title` stays the first real prompt.
  `query` also matches the shown title. `sessions:read` `meta()` also gives
  `title` and `titleSource`.
- **Utility model**: `host.models.utilityFor(providerId?)` (capability
  `models:read`, `ResolvedUtilityModel`; `resolveUtilityModel` in
  `src/llm/model-info.ts`). Order: the adapter `recommendUtilityModel()`
  (`UtilityModelRecommendation`), then the first model with the tag
  `utility`, then the tag `fast`. Tag steps skip `reasoning`, `flagship` and
  `balanced` models. Each step must pass the price ceiling (1.0). It never
  gives the session model. The default provider is the live session
  provider.

## Migration notes

- All API changes are additive. No exported name or shape was removed.
  `package.json` and `public-exports.json` have no change: the types come
  through the existing plugin-api subpaths.
- Behavior change: `llm.complete()` usage (ma-memory) now goes to the aux
  totals, not to `turns` and `contextSize`.
- The title cost is not in `/usage` and not in the session row cost.
- Old builds ignore title lines in `index-meta.jsonl` (their readers keep only
  summary and tombstone lines). They show the first prompt as before.
- A fork or a copied session file does not carry the title.

## Addendum: minimal side call and the provider title profile (R10, R11)

This section replaces the "Utility model" order above.

### F1 behavior changes

- `llm.request()` requires `model` for every purpose. No request falls back
  to the default model (`reason: "no-model"`).
- Two price ceilings apply to every purpose: input
  (`maxUsdPerMTokIn`, default 1.0 USD per 1M tokens) and output
  (`maxUsdPerMTokOut`, default 5.0 USD per 1M tokens,
  `DEFAULT_SIDE_MAX_USD_PER_MTOK_OUT`). A model with no known price is
  rejected (`unknown-price`).

### R10: the minimal call

- `system` = the provider preamble. Core calls the `resolveSystemPrompt` of
  the provider plugin of the model with `identity: ""`, `body` = the caller
  text, the credential `authKind` and the `modelId`
  (`buildSideSystem` in `llm-side.ts`). Empty blocks are dropped. A provider
  with no `resolveSystemPrompt` gets the caller text as the only block.
- No prompt fragments, no AGENTS.md, no tools, no `message.willSend` or
  `message.didSend` hooks. Exactly one user message. `max_tokens` is the
  caller value (default 1024).
- One attempt, one abort signal and the aux usage frame stay as before.

### R11: the provider title profile

- `UtilityModelRecommendation` (and `ResolvedUtilityModel`) get two optional
  fields: `effort?: "low" | "medium" | "high"` and
  `stream?: "off" | "required"`.
- `stream: "off"`: the adapter accepts a non-stream request for this model
  and credential; core sends `stream: false`. `"required"` or absent: core
  sends `stream: true` and drains the stream (`sideStreamFlag` in
  `llm-side.ts`). Before this change, the side call always sent
  `stream: false`.
- `resolveUtilityModel` / `host.models.utilityFor` use ONLY the adapter
  `recommendUtilityModel()`. The `utility` tag step is removed: no
  recommendation gives `undefined`, and the title plugin makes no call. The
  price ceilings still apply to the recommended model. The result carries
  `thinkingOff`, `effort` and `stream`.
- Migration: a provider that wants titles must implement
  `recommendUtilityModel()`. A `utility` tag alone no longer selects a model.
