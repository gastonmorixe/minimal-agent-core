/**
 * Wrap a {@link TransportFn} so every send runs {@link LifecyclePort.beforeSend}
 * (message.willSend) and {@link LifecyclePort.afterSend} (message.didSend).
 *
 * On deny, throws {@link LifecycleSendDeniedError} without calling the inner
 * transport (no network).
 *
 * @module sdk/with-lifecycle-send
 */

import type { ContentBlock, Message } from "../llm/messages.ts"
import type {
  SendOptions,
  StreamedResponse,
  SystemBlock,
  TransportFn,
} from "../llm/transport/types.ts"

import {
  collectAdditionalContext,
  isDenied,
  type LifecyclePort,
  type SendSnapshot,
} from "./lifecycle.ts"

/** Thrown when `message.willSend` / beforeSend denies the request. */
export class LifecycleSendDeniedError extends Error {
  readonly reason: string
  readonly additionalContext: string[]
  constructor(reason: string, additionalContext: string[] = []) {
    super(reason)
    this.name = "LifecycleSendDeniedError"
    this.reason = reason
    this.additionalContext = additionalContext
  }
}

function systemToSnapshot(system: SystemBlock[] | undefined): string | ContentBlock[] {
  if (!system || system.length === 0) return ""
  if (system.length === 1 && system[0]) return system[0].text
  return system.map((b) => ({ type: "text" as const, text: b.text }))
}

function snapshotToSystem(system: string | ContentBlock[]): SystemBlock[] | undefined {
  if (typeof system === "string") {
    return system.length > 0 ? [{ type: "text", text: system }] : undefined
  }
  const blocks: SystemBlock[] = []
  for (const b of system) {
    if (b.type === "text") blocks.push({ type: "text", text: b.text })
  }
  return blocks.length > 0 ? blocks : undefined
}

/**
 * Return a transport that consults `lifecycle.beforeSend` before each call.
 * When `lifecycle` is missing or has no `beforeSend`, returns `inner` unchanged.
 */
export function wrapTransportWithLifecycle(
  inner: TransportFn,
  lifecycle: LifecyclePort | null | undefined,
): TransportFn {
  if (!lifecycle?.beforeSend) return inner

  return async function* lifecycleSend(
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    const snapshot: SendSnapshot = {
      messages: opts.messages,
      system: systemToSnapshot(opts.system),
      model: opts.model ?? "",
      ...(opts.selectedProviderId ? { providerId: opts.selectedProviderId } : {}),
    }
    const decision = await lifecycle.beforeSend!(snapshot)
    if (isDenied(decision)) {
      const reason =
        decision.action === "deny" || decision.action === "ask"
          ? decision.reason
          : "Send blocked by lifecycle policy hook."
      throw new LifecycleSendDeniedError(reason, collectAdditionalContext(decision))
    }
    const nextMessages: Message[] =
      decision.action === "allow" ? decision.payload.messages : opts.messages
    const nextSystem =
      decision.action === "allow" ? snapshotToSystem(decision.payload.system) : opts.system
    const nextOpts: SendOptions = {
      ...opts,
      messages: nextMessages,
      ...(nextSystem !== undefined ? { system: nextSystem } : { system: undefined }),
    }
    const gen = inner(nextOpts)
    let result: StreamedResponse | undefined
    while (true) {
      const { done, value } = await gen.next()
      if (done) {
        result = value as StreamedResponse
        break
      }
      yield value
    }
    try {
      await lifecycle.afterSend?.(decision.action === "allow" ? decision.payload : snapshot)
    } catch {
      /* observation only */
    }
    return result ?? { blocks: [], text: "", stopReason: null }
  }
}
