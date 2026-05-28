/**
 * Provider-neutral transport that satisfies the legacy `Agent.sendFn`
 * contract by routing through the canonical `run()` orchestrator.
 *
 * Signature-compatible with `client.ts`'s `sendMessage`:
 *
 *   (opts: SendOptions) => AsyncGenerator<string, StreamedResponse>
 *
 * so it is a drop-in for `Agent`'s injectable transport. The difference
 * is WHERE the request goes: `sendMessage` always hits Anthropic;
 * `canonicalSendFn` resolves `opts.model` through the model registry and
 * dispatches to whichever provider adapter owns it (Anthropic, OpenAI
 * Chat/Responses, OpenRouter, ...). This is what makes `--model gpt-5.5`
 * actually reach OpenAI through the agent loop.
 *
 * # Layering
 *
 * This is the **Phase 1** raw transport: it does NOT yet carry the
 * stream-idle / hard-timeout watchdog, the retry/backoff coordinator, or
 * the 401 keychain-first refresh. Those are provider-neutral middleware
 * added in Phase 2 (`./watchdog.ts`, `./retry.ts`, `./auth-refresh.ts`)
 * and composed around the inner `run()` call here. Until then the default
 * `Agent.sendFn` stays `sendMessage`, and this transport is opt-in.
 *
 * # Translation
 *
 * - request:  `SendOptions -> CanonicalRequest` via `sendOptionsToCanonical`.
 * - auth:     `AuthResult -> ProviderAuth` via `legacyAuthToProviderAuth`.
 * - response: `CanonicalEvent stream -> (yield string, return
 *             StreamedResponse) + lifecycle callbacks` via
 *             `canonicalEventsToLegacyStream`.
 *
 * @module llm/transport/canonical-send
 */

import type { SendOptions, StreamedResponse } from "../../client/types.ts"
import {
  canonicalEventsToLegacyStream,
  legacyAuthToProviderAuth,
  sendOptionsToCanonical,
} from "../adapter-legacy.ts"
import type { RunContext } from "../provider.ts"
import { run } from "../run.ts"

/**
 * Stream a request through the canonical layer while presenting the
 * legacy `sendMessage` surface.
 *
 * @param opts Legacy send options (auth, messages, model, tools, ...).
 * @yields Text deltas (the legacy string channel).
 * @returns The final {@link StreamedResponse} once the stream completes.
 */
export async function* canonicalSendFn(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  const req = sendOptionsToCanonical(opts)
  const ctx: RunContext = {
    auth: legacyAuthToProviderAuth(opts.auth),
    // SendOptions carries no sessionId; request metadata is wired in
    // Phase 3 when the agent threads its real session id through.
    sessionId: "",
    networkClient: opts.networkClient,
  }
  const events = run(req, { context: ctx })
  return yield* canonicalEventsToLegacyStream(events, {
    onThinkingStart: opts.onThinkingStart,
    onThinkingDelta: opts.onThinkingDelta,
    onThinkingStop: opts.onThinkingStop,
    onTextStop: opts.onTextStop,
  })
}
