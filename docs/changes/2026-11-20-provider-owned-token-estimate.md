# Provider-owned token estimate (core has no ratio)

Date: 2026-11-20. Scope: core and plugin-api. Plan:
`.scratch/token-estimate-plan.md` (umbrella repo). BREAKING for plugins.

## The rule

Token estimation is a provider -> model decision. The provider plugin sets
`ModelEntry.estimateTokens` for each model. Core holds NO ratio, NO formula
default and NO hardcoded number. When a (provider, model) pair has no
estimator, core has no estimate, and each caller does a specified thing.

## API

plugin-api `llm/token-estimate` (building blocks only):

- `type TokenEstimator = (text: string) => number`
- `makeCharRatioEstimator(charsPerToken: number): TokenEstimator`. No
  default. A ratio that is not a finite number > 0 throws a `RangeError`
  at construction (plugin load).
- `makeCharClassEstimator(params: CharClassEstimatorParams): TokenEstimator`.
  A synchronous char-class weighted heuristic, modelled on `tokenx`: ASCII
  letter runs (short words are one token), digit groups, punctuation runs,
  whitespace runs (one plain space is free), CJK/Kana/Hangul, optional
  extra script ranges, other code points, and an optional `scale`. All
  weights are required. One pass, no regex, no dependency, monotonic.
- Removed: `DEFAULT_CHARS_PER_TOKEN`, `estimateTokensFromText`.

Core `src/llm/token-estimate.ts` and the host subpath
`@minimal-agent/core/host/token-estimate`:

- `lookupTokenEstimator(modelId, providerId?): TokenEstimator | undefined`.
  Provider-scoped entry first, then the global id or alias. No fallback.
- `estimateTokensForModel(modelId, text, providerId?): number | undefined`.

## Callers and the behavior with no estimator

| Caller | With no estimator |
|---|---|
| `estimateRequestInputTokens` (`llm/context-budget.ts`) <- `resolveMaxOutputTokens` (`sdk/run-temperature.ts`) <- `send-attempt.ts` | UTF-8 byte count of the same parts (the upper bound, see below). The clamp gives a smaller `max_tokens`, never an overflow. |
| `canonical-send.ts` (provider gave no usage) | No `addSessionEstimatedUsage`. The context bar keeps its last real value. |
| `computeSessionUsage` (`session/session-usage.ts`) | The turn adds 0 tokens and the result gets `tokensUnknown: true` (`estimated` stays `true`). The session store and the catalog do not write a summary with `tokensUnknown` to `index-meta.jsonl`, so a later estimator can give the count. The CLI sessions list shows `—`. |
| `usage-stats.ts` | `tokens: 0, estimated: true, tokensUnknown: true` for that turn; `UsageTotals.unknownTurns` counts these turns. |
| Live rate (`stream-delta.ts`, `llm.outputDelta`) | No delta. The host shows no token rate. |
| Compact progress (`run-compact.ts`) | No `onProgress` and no `llm.outputDelta`. The text stream still goes to `writeStream`. |

## Why bytes are an upper bound

A byte-level BPE (GPT-2, o200k, Llama 3 and most modern tokenizers) works
on the UTF-8 bytes, and each token covers one byte or more. A SentencePiece
tokenizer with byte fallback also never makes a token that covers less than
one byte. Thus tokens <= UTF-8 bytes for the text. The few framing tokens
for each message are far below the over-count (prose is about 3-4 bytes for
each token) and the clamp safety margin (`DEFAULT_OUTPUT_SAFETY_MARGIN`).
The bound needs no ratio. `context-exceeded-recovery.ts` stays the second
net.

## Other changes

- `RequestSnapshot.providerId`: the selected provider
  (`SendOptions.selectedProviderId`), else the registry provider of the
  model (`resolveRequestProviderId` in `canonical-send.ts`).
- `StreamDeltaAccumulator.add(text)` takes the text (was a char count).
  `getStreamDeltaAccumulator(estimateTokens?)` and
  `StreamAssemblerHooks.estimateTokens` carry the estimator.
- `EstimateRequestInputTokensInput.providerId` and the export
  `utf8ByteLength` are new.
- Test fixture `TestModelSpec.estimateTokens` is new.

## Next steps (other packages)

- Each `ma-llm-*` plugin chooses the estimator for each model (the
  aggregators by vendor prefix). The generic endpoint has no estimator
  unless its config gives one.
- The `lib/host-types.ts` copies in the plugins follow the new signatures.
- CLI: the request dump shows bytes only when the token count is
  `undefined`, and uses `RequestSnapshot.providerId` with one lookup for
  each dump.
