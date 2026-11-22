/**
 * Wrap a {@link TransportFn} so every send runs {@link LifecyclePort.beforeSend}
 * (message.willSend) and {@link LifecyclePort.afterSend} (message.didSend).
 *
 * On deny, throws a `LifecycleDeniedError` (hook `message.willSend`) without
 * calling the inner transport (no network).
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
import type { SidebandApi } from "../sideband/types.ts"

import {
  deniedError,
  isDenied,
  type LifecyclePort,
  type SendRequestView,
  type SendSnapshot,
} from "./lifecycle.ts"
import { resolveMaxOutputTokens } from "./run-temperature.ts"

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
 * that are set are copied, so the snapshot stays small and stable. Object
 * values are deep copies: a listener that edits the view in place cannot
 * change the request that goes to the transport. Exported for tests.
 */
export function requestView(opts: SendOptions): SendRequestView {
  const view: SendRequestView = {}
  if (opts.requestType !== undefined) view.requestType = opts.requestType
  if (opts.tools !== undefined) view.tools = structuredClone(opts.tools)
  if (opts.maxTokens !== undefined) view.maxTokens = opts.maxTokens
  if (opts.thinking !== undefined) view.thinking = structuredClone(opts.thinking)
  if (opts.outputConfig !== undefined) view.outputConfig = structuredClone(opts.outputConfig)
  if (opts.temperature !== undefined) view.temperature = opts.temperature
  return view
}

/**
 * The output budget again after a `message.willSend` listener changed the
 * request. The sender sized `opts.maxTokens` on the messages before the hook
 * ({@link resolveMaxOutputTokens}). A listener that grows a message (for
 * example an expansion of a ref) can push a model whose output shares the
 * context window over the window. So after the listener, the same function
 * sizes the cap again on the new request. The cap can only get smaller: it is never above the cap of
 * the sender. The estimate reads the text only, so a copy with the same text
 * gives the same cap.
 *
 * The cap is computed again also when the listener gave back the SAME
 * objects: a listener can change the array (or a message) in place, and an
 * identity check does not see that. The estimate is cheap.
 *
 * Nothing changes (an empty object) when the request has no `maxTokens`, or
 * when the registry does not know the model.
 */
function rebudgetMaxTokens(
  opts: SendOptions,
  nextMessages: Message[],
  nextSystem: SystemBlock[] | undefined,
): { maxTokens?: number } {
  if (opts.maxTokens === undefined) return {}
  const next = resolveMaxOutputTokens(opts.model ?? "", opts.selectedProviderId, nextMessages, {
    ...(nextSystem ? { system: nextSystem } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  })
  if (next === undefined || next >= opts.maxTokens) return {}
  return { maxTokens: next }
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
    // The action decides, never the reason text: a deny with no reason
    // still throws.
    if (isDenied(decision)) throw deniedError("message.willSend", decision)
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
      ...rebudgetMaxTokens(opts, nextMessages, nextSystem),
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

/**
 * Return a transport that puts the session sideband API on each send
 * (`SendOptions.sideband`, then the provider `RunContext.sideband`). A
 * caller value wins. The request bytes do not change.
 */
export function withSessionSideband(
  inner: TransportFn,
  sideband: SidebandApi | undefined,
): TransportFn {
  if (!sideband) return inner
  return (opts: SendOptions) => inner(opts.sideband ? opts : { ...opts, sideband })
}
