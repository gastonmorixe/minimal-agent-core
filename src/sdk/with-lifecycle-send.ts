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
  type SendRequestView,
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

/**
 * Build the listener-facing system view. Multi-block systems keep each
 * block's `cache_control` so listeners can see (and keep) the markers.
 * Exported for the compact runner (item 8), which applies the same rule.
 */
export function systemToSnapshot(system: SystemBlock[] | undefined): string | ContentBlock[] {
  if (!system || system.length === 0) return ""
  if (system.length === 1 && system[0]) return system[0].text
  return system.map((b) =>
    b.cache_control
      ? { type: "text" as const, text: b.text, cache_control: { ...b.cache_control } }
      : { type: "text" as const, text: b.text },
  )
}

function sameCacheControl(
  a: SystemBlock["cache_control"],
  b: SystemBlock["cache_control"],
): boolean {
  return a?.type === b?.type && a?.ttl === b?.ttl && a?.scope === b?.scope
}

/**
 * Map the listener's system back to wire blocks WITHOUT losing prompt-cache
 * markers (`cache_control` type / ttl / scope).
 *
 * - Same block count as `original`: a block with the same text (and no
 *   different marker) reuses the original object whole. When every block is
 *   unchanged, the original array is returned (byte-identical wire).
 *   A changed block keeps its own `cache_control`, else inherits
 *   `original[i].cache_control`, so a redaction that rebuilds blocks as bare
 *   text keeps the breakpoint layout. Limit: a same-count reorder inherits
 *   markers by position.
 * - Different block count: the listener replaced the system. Use its markers
 *   only.
 *
 * Dropping the markers made every new session and sub-agent pay a full
 * system cache write, and lost the configured TTL and the global scope.
 * Exported for the compact runner (item 8), which applies the same rule.
 */
export function snapshotToSystem(
  system: string | ContentBlock[],
  original: SystemBlock[] | undefined,
): SystemBlock[] | undefined {
  // No reference fast path: a listener may mutate the snapshot in place and
  // return the same object. Per-block text equality below decides reuse.
  const texts: { text: string; cache_control?: SystemBlock["cache_control"] }[] = []
  if (typeof system === "string") {
    if (system.length > 0) texts.push({ text: system })
  } else {
    for (const b of system) {
      if (b.type === "text") {
        texts.push(
          b.cache_control ? { text: b.text, cache_control: b.cache_control } : { text: b.text },
        )
      }
    }
  }
  if (texts.length === 0) return undefined
  const sameShape = original !== undefined && original.length === texts.length
  if (sameShape) {
    // Unchanged block (same text, marker absent or equal): reuse the original
    // object whole. All unchanged: reuse the original array (byte-identical).
    const reused = texts.map((t, i) => {
      const o = original[i]
      if (!o || o.text !== t.text) return undefined
      if (t.cache_control && !sameCacheControl(t.cache_control, o.cache_control)) return undefined
      return o
    })
    if (reused.every((o) => o !== undefined)) return original
    return texts.map((t, i) => {
      const o = reused[i]
      if (o) return o
      const cc = t.cache_control ?? original[i]?.cache_control
      return cc
        ? { type: "text", text: t.text, cache_control: { ...cc } }
        : { type: "text", text: t.text }
    })
  }
  return texts.map((t) => {
    const cc = t.cache_control
    return cc
      ? { type: "text", text: t.text, cache_control: { ...cc } }
      : { type: "text", text: t.text }
  })
}

/**
 * Build the read-only {@link SendRequestView} from send options. Only keys
 * that are set are copied, so the snapshot stays small and stable.
 * Exported for tests.
 */
export function requestView(opts: SendOptions): SendRequestView {
  const view: SendRequestView = {}
  if (opts.requestType !== undefined) view.requestType = opts.requestType
  if (opts.tools !== undefined) view.tools = opts.tools
  if (opts.maxTokens !== undefined) view.maxTokens = opts.maxTokens
  if (opts.thinking !== undefined) view.thinking = opts.thinking
  if (opts.outputConfig !== undefined) view.outputConfig = opts.outputConfig
  if (opts.temperature !== undefined) view.temperature = opts.temperature
  return view
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
      request: requestView(opts),
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
      decision.action === "allow"
        ? snapshotToSystem(decision.payload.system, opts.system)
        : opts.system
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
