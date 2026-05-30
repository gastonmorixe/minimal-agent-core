# Provider preflight + askUser modal: fix Anthropic thinking-block model-fork 400

**Status:** shipped (provider-neutral preflight contract, Anthropic detection + resolution, agent send-loop pipeline, live-area modal).
**Owner:** agent (session 06048901)
**Bug report:** session cc53c9fe (`messages.11.content.201: 'thinking' or 'redacted_thinking' blocks in the latest assistant message cannot be modified`).
**Builds on:** [`2026-05-29-provider-capabilities.md`](./2026-05-29-provider-capabilities.md) (provider seam) and [`2026-05-28-openai-provider-and-plugin-seam.md`](./2026-05-28-openai-provider-and-plugin-seam.md) (`ProviderPlugin` contract).

The Anthropic API rejects requests whose latest assistant message contains thinking blocks signed by a different model than the request targets. This happens whenever a session is resumed (or forked) with a different `--model` than the one that originally produced the thinking. Three prior attempts (`22b50d0`, `6fff370`, `252cb7d`) addressed adjacent symptoms (formatter, trailing newline, persistence docs) but missed the root cause. This change introduces a clean provider-neutral preflight pipeline that detects the mismatch BEFORE the API call and surfaces a modal in the live area so the user picks the resolution: strip the stale blocks, switch back to the original model, or cancel.

## What shipped

### 1. Provider-neutral preflight contract (`src/llm/provider.ts`)

Two new optional methods on `ProviderAdapter` and three supporting types:

- `PreflightOption` — one mutually-exclusive resolution the user can pick (`id`, `label`, optional `description`, `isDefault`, `destructive`).
- `PreflightIssue` — one issue the provider detected (`code`, `title`, `detail`, `options[]`).
- `PreflightResolution` — `{kind:"modify-request", request, adoptModelId?}` or `{kind:"cancel"}`.
- `ProviderAdapter.preflight?(req, model): PreflightIssue[]` — provider-side pure scan.
- `ProviderAdapter.applyResolution?(req, issueCode, optionId): PreflightResolution` — apply the chosen option.

Provider-neutral wrapper `src/llm/preflight.ts` exposes `runPreflight(req)` and `applyPreflightResolution(req, code, option)` which resolve `req.modelId → ModelEntry → ProviderAdapter` through the registry and dispatch. Catches exceptions defensively so a buggy adapter cannot wedge the agent. 10 tests in `src/llm/preflight.test.ts`.

### 2. Anthropic detection + resolution (`plugins/llm-anthropic/`)

Two new files, no provider knowledge leaks into the agent:

- **`signature-model.ts`** — `extractModelFromSignature(sig)` decodes the model id Anthropic embeds in every thinking-block signature (protobuf field 6, length-delimited). Verified against 22 real signatures from cc53c9fe. 14 tests in `signature-model.test.ts`.
- **`thinking-preflight.ts`** — `findThinkingMismatches(messages, modelId)` walks every thinking block and returns the ones whose signature decodes to a model other than the target. `buildMismatchIssue(mismatches, target)` shapes the `PreflightIssue`. `stripThinkingBlocks(messages)` returns a new array with all `thinking`/`redacted_thinking` blocks removed (preserves text/tool_use/tool_result). `applyMismatchResolution(req, optionId)` translates the user's choice (`OPTION_STRIP`, `OPTION_SWITCH_PREFIX + modelId`, `OPTION_CANCEL`) into a structured outcome. 30 tests in `thinking-preflight.test.ts`.

The Anthropic adapter (`adapter.ts`) wires both into the `preflight()` and `applyResolution()` methods. Issue code: `"anthropic.thinking-model-mismatch"`. Option ids: `"strip"`, `"switch:<modelId>"`, `"cancel"`. 10 tests in `adapter.preflight.test.ts`.

### 3. Generic TUI modal (`src/ui/choice-modal.ts`)

`ChoiceModal` implements the existing `LiveOverlay` interface:

- Title, word-wrapped body, N labelled options, focused option's description, key-hint footer.
- Navigation: `←/→`, `↑/↓`, `Tab` cycle; `Enter` confirm; `Esc` cancel (returns `null`).
- Single-char shortcuts on the first non-symbol character of each label (ambiguous shortcuts ignored).
- Destructive options render with a ⚠ glyph in yellow.
- Auto-stacks button row when too wide for the modal width.

28 tests in `choice-modal.test.ts` cover rendering, navigation, char shortcuts, esc/cancel, narrow widths, and `\n` paragraph breaks in the body.

### 4. Agent send-loop pipeline (`src/agent/preflight-pipeline.ts`)

`runPreflightPipeline({messages, modelId, askUser})` bridges the agent's legacy `Message[]` world to the canonical `CanonicalRequest` preflight, calls `askUser` once per issue, and returns the modified messages + (optionally) the adopted model id. Uses the existing `legacyMessageToCanonical` / `canonicalMessageToLegacy` converters from `adapter-legacy.ts` (newly `export`-ed).

Wired into `Agent.run`'s tool loop: just before each `sendFn` call, the pipeline runs. When the user picks STRIP, `this.messages` is rewritten in-place; when SWITCH, `this.model` is updated; when CANCEL, the run throws `AbortError`. 8 pipeline tests + 6 agent-integration tests (`src/agent.preflight.test.ts`).

The agent's contract is provider/model-free: it imports only the canonical wrapper and the `AskUserFn` type. No Anthropic identifiers reach `src/agent.ts`.

### 5. Live-area modal host (`src/agent/ask-user-host.ts`)

`createAskUserHost({editor, hooks})` builds an `AskUserFn` that:

1. Constructs a `ChoiceModal` from the `PreflightIssue`.
2. Paints it into the editor's footer overlay layer (`FOOTER_LAYER_OVERLAY`, `FOOTER_PRIORITY_OVERLAY`).
3. Subscribes to `editor.key` at priority 9999 so it beats every plugin (slash-menu, history, autocomplete).
4. Translates editor key names (`"ArrowLeft"`, `"Enter"`, `"Escape"`, char/Ctrl+X) into `OverlayKey` shapes via `translateEditorKey()`.
5. Halts every key while the modal is up so the editor buffer underneath cannot receive input.
6. On `{close, result}`: clears the footer layer, disposes the hook, resolves the promise with the chosen option id (or `null`).

16 tests in `ask-user-host.test.ts` cover the key translation table and the full open → navigate → resolve → cleanup loop.

`runReplLiveArea` constructs the host once per session (when both `setFooterLayer` and the plugin loader are present) and threads `askUser` into every `agent.run(text, { askUser })` call. Headless tests / setups without a real editor leave it undefined and the agent skips preflight entirely.

### 6. End-to-end regression test

`plugins/llm-anthropic/forked-session.e2e.test.ts` loads a 5-record fixture extracted from the real cc53c9fe session (`__fixtures__/forked-session-mixed-models.jsonl`, 5.8 kB) through `loadSessionFromText` and exercises every resolution path. The fixture preserves the actual signatures (claude-opus-4-7 bytes) so the test would have caught the original bug. 7 tests.

## How the user sees it

When you resume a session whose thinking blocks were signed by a different model than `--model`, the next send opens a modal in the live area before hitting the network. Rendered with `--model claude-opus-4-8` resuming a session signed by claude-opus-4-7:

```
╭──────────────────────────────────────────────────────────────────────╮
│ Conversation has thinking blocks from a different model              │
│                                                                      │
│ This conversation contains thinking blocks signed by claude-opus-4-7 │
│ (16 blocks) but the current request targets claude-opus-4-8.         │
│ Anthropic verifies each thinking-block signature against the         │
│ request's model, so the API will reject the request with a 400       │
│ unless we either drop the stale blocks or switch back to the         │
│ original model.                                                      │
│ This usually happens after a session was forked or resumed with a    │
│ different --model.                                                   │
│                                                                      │
│ ❮ ⚠ Strip stale thinking, continue with claude-opus-4-8 ❯            │
│   Switch back to claude-opus-4-7                                     │
│   Cancel                                                             │
│                                                                      │
│ Remove the mismatched thinking blocks and send. The model loses its  │
│ prior reasoning context but the conversation continues.              │
│                                                                      │
│ ← →: navigate Enter: confirm Esc: cancel                             │
╰──────────────────────────────────────────────────────────────────────╯
```

`Strip` is the default (destructive, in yellow with ⚠). `Switch back` keeps all reasoning context and updates `--model` for the rest of the session. `Cancel` aborts the send.

The detection runs on every `agent.run()` iteration but the modal only opens when an actual mismatch is present, so the steady-state cost is one `O(B)` signature scan per send (~µs for the largest cc53c9fe-scale histories). Once resolved, subsequent sends see clean messages and no further modals.

## What did NOT change

- The session JSONL format. Thinking blocks (with signatures) are persisted exactly as before; the fix is purely client-side on the SEND path.
- The default agent behavior with no `askUser` callback wired (e.g. headless tests, scripts using `Agent.run` directly): preflight is skipped and any provider error surfaces as a normal API failure. Hosts opt in.
- Provider plugins other than Anthropic: `openai`, `openrouter`, `deepseek` leave `preflight` undefined and the pipeline returns `[]`. Zero overhead.

## Files

```
src/llm/provider.ts                         (+78  preflight types + adapter methods)
src/llm/preflight.ts                        (+74  new)
src/llm/preflight.test.ts                   (+157 new)
src/llm/index.ts                            (+1   re-export preflight)
src/llm/adapter-legacy.ts                   (~2   exported legacyMessageToCanonical + canonicalMessageToLegacy)
src/ui/choice-modal.ts                      (+228 new)
src/ui/choice-modal.test.ts                 (+199 new)
src/agent/preflight-pipeline.ts             (+108 new)
src/agent/preflight-pipeline.test.ts        (+175 new)
src/agent/ask-user-host.ts                  (+147 new)
src/agent/ask-user-host.test.ts             (+218 new)
src/agent.ts                                (+34  askUser opt + preflight call)
src/agent/repl.ts                           (+11  askUser typing on ReplAgentLike)
src/agent/repl-live-area.ts                 (+38  build + thread askUser into agent.run)
src/agent.preflight.test.ts                 (+217 new agent integration)
plugins/llm-anthropic/signature-model.ts                    (+135 new)
plugins/llm-anthropic/signature-model.test.ts               (+128 new)
plugins/llm-anthropic/thinking-preflight.ts                 (+230 new)
plugins/llm-anthropic/thinking-preflight.test.ts            (+295 new)
plugins/llm-anthropic/adapter.ts                            (+56  preflight + applyResolution wiring)
plugins/llm-anthropic/adapter.preflight.test.ts             (+154 new)
plugins/llm-anthropic/forked-session.e2e.test.ts            (+165 new)
plugins/llm-anthropic/__fixtures__/forked-session-mixed-models.jsonl  (+5839 B, real cc53c9fe extract)
plugins/llm-anthropic/index.ts                              (+14  re-exports)
```

Test counts: **62 unit + 18 integration + 7 e2e = 87 new tests, all passing.** Full suite: 3 658 pass / 0 fail / 10 skip.

## Why this is the right shape

- **The agent is provider/model-free.** Nothing in `src/agent.ts` mentions thinking blocks, signatures, or Anthropic. The provider-neutral preflight is the only contract.
- **The provider plugin owns the detection.** All thinking-block knowledge lives in `plugins/llm-anthropic/`. Adding a similar detection for OpenAI (if their format ever needs one) is a parallel implementation, no cross-cutting changes.
- **The TUI modal is generic.** `ChoiceModal` is not Anthropic-specific. Future plugins that need a structured user-choice modal can reuse it directly.
- **No silent stripping.** Per the user's requirement: the agent NEVER drops thinking blocks on its own. The modal always asks. The strip is destructive and clearly labelled.
- **No re-asking.** Once the user resolves the issue (or switches model), subsequent sends find no mismatches and the modal stays closed.
