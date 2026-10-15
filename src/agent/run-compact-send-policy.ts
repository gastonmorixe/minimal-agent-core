/**
 * `message.willSend` policy for the compact send paths (local summary and
 * remote `adapter.compact`). Split out of run-compact.ts to stay under the
 * max-lines budget.
 *
 * @module agent/run-compact-send-policy
 */

import type { CanonicalBlock } from "../llm/canonical-messages.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import type { Message } from "../llm/messages.ts"
import type { SystemBlock } from "../llm/transport/types.ts"
import {
  collectAdditionalContext,
  isDenied,
  type LifecyclePort,
  type SendSnapshot,
} from "../sdk/lifecycle.ts"
import {
  LifecycleSendDeniedError,
  snapshotToSystem,
  systemToSnapshot,
} from "../sdk/with-lifecycle-send.ts"

/** Inputs to the compact send policy decision. */
export interface CompactSendInput {
  /** Live legacy history (not mutated). */
  messages: Message[]
  /** Summary system blocks from the provider plugin. */
  system: CanonicalRequest["system"]
  /** Model id for the snapshot. */
  modelId: string
  /** Provider id for the snapshot. */
  providerId: string
}

/** What a compact path sends after `message.willSend` decided. */
export interface CompactSendPayload {
  /** Legacy history to build the wire messages from. */
  messages: Message[]
  /** Canonical system blocks to send, or `undefined` for none. */
  system: CanonicalRequest["system"]
  /**
   * Snapshot for `message.didSend` (`lifecycle.afterSend`): the listener's
   * allowed payload, or `undefined` when no `beforeSend` ran.
   */
  didSend?: SendSnapshot
}

/**
 * Run `message.willSend` (`lifecycle.beforeSend`) ONCE for a compact request
 * and return the payload to build the wire request from. Same snapshot shape
 * as a live send (`sdk/with-lifecycle-send.ts`): messages, system, model,
 * and providerId, where `messages` is a copy of the legacy history with its
 * tool_use and tool_result blocks. Each path then builds its own request from
 * the result (local: flat summary text, remote: canonical messages).
 *
 * - No `beforeSend`: returns the input unchanged (same bytes).
 * - `beforeSend` throws: rethrows an Error that names only the error class
 *   (never its message). Callers fall back to the stub with no send.
 * - Deny / ask: throws {@link LifecycleSendDeniedError}. Callers fall back to
 *   the stub checkpoint and never touch the network.
 * - Allow: takes messages and system from the payload. A system block the
 *   listener left unchanged reuses the original block object (item 0 rule:
 *   cache hint, ttl, and scope survive).
 *
 * Non-text system blocks: the listener sees ONLY the text blocks (a snapshot
 * system is text). Non-text blocks are not shown and are kept as is. When the
 * listener keeps the text block count, each text block goes back to its
 * original index between the non-text blocks. When the count changes, the
 * non-text blocks come first, then the listener's text blocks.
 *
 * Called before the retry / 401 loop, so a token retry reuses the redacted
 * request and the hook runs once per compact request.
 *
 * `didSend` is set only when `beforeSend` ran. A port with `afterSend` but no
 * `beforeSend` gets no `message.didSend` for compaction. This matches
 * `withLifecycleSend`, which also skips `afterSend` when no `beforeSend` ran.
 *
 * @param args - Live history, summary system, model and provider ids.
 * @param lifecycle - Send policy port.
 * @returns The payload to send (redacted when a listener changed it).
 */
export async function decideSendPolicy(
  args: CompactSendInput,
  lifecycle: LifecyclePort,
): Promise<CompactSendPayload> {
  const sysIn = args.system ?? []
  if (!lifecycle.beforeSend) return { messages: args.messages, system: args.system }
  const textIdx: number[] = []
  sysIn.forEach((b, i) => {
    if (b.type === "text") textIdx.push(i)
  })
  const legacySys: SystemBlock[] = textIdx.map((i) => canonicalSystemToLegacy(sysIn[i]!))
  const snapshot: SendSnapshot = {
    messages: args.messages.slice(),
    system: systemToSnapshot(legacySys),
    model: args.modelId,
    providerId: args.providerId,
  }
  let decision: Awaited<ReturnType<NonNullable<LifecyclePort["beforeSend"]>>>
  try {
    decision = await lifecycle.beforeSend(snapshot)
  } catch (err) {
    // A throwing port fails closed (caller uses the stub). Keep only the
    // error name: a listener message may quote payload text.
    const name = err instanceof Error && err.name ? err.name : typeof err
    // oxlint-disable-next-line preserve-caught-error -- `cause` would carry the listener message, which may quote secret payload text
    throw new Error(`send policy hook threw ${name}`)
  }
  if (isDenied(decision)) {
    const reason =
      decision.action === "deny" || decision.action === "ask"
        ? decision.reason
        : "Send blocked by lifecycle policy hook."
    throw new LifecycleSendDeniedError(reason, collectAdditionalContext(decision))
  }
  if (decision.action !== "allow") {
    return { messages: args.messages, system: args.system, didSend: snapshot }
  }
  const nextSys = snapshotToSystem(decision.payload.system, legacySys)
  return {
    messages: decision.payload.messages,
    system: mergeSystem(sysIn, args.system, textIdx, legacySys, nextSys),
    didSend: decision.payload,
  }
}

/**
 * Call `message.didSend` (`lifecycle.afterSend`) after a successful compact
 * send. Observation only: a throw is swallowed and never fails compact.
 *
 * - Runs only when {@link decideSendPolicy} set `didSend`, so a port with
 *   `afterSend` but no `beforeSend` gets no call. Same as `withLifecycleSend`.
 * - `afterSend` is awaited. A slow observer delays compaction, the same as
 *   the live send wrapper.
 *
 * @param lifecycle - Send policy port.
 * @param sent - Payload returned by {@link decideSendPolicy}.
 */
export async function notifyDidSend(
  lifecycle: LifecyclePort,
  sent: CompactSendPayload,
): Promise<void> {
  if (!sent.didSend) return
  try {
    await lifecycle.afterSend?.(sent.didSend)
  } catch {
    // Observation only.
  }
}

/** Put the listener's text system blocks back next to the non-text originals. */
function mergeSystem(
  sysIn: CanonicalBlock[],
  original: CanonicalRequest["system"],
  textIdx: number[],
  legacySys: SystemBlock[],
  nextSys: SystemBlock[] | undefined,
): CanonicalRequest["system"] {
  // Every text block unchanged: keep the original array (same bytes).
  if (nextSys === legacySys) return original
  const toCanonical = (b: SystemBlock, i: number): CanonicalBlock => {
    const at = textIdx[i]
    return b === legacySys[i] && at !== undefined && sysIn[at]
      ? sysIn[at]
      : legacySystemToCanonical(b)
  }
  const nonText = sysIn.filter((b) => b.type !== "text")
  if (!nextSys) return nonText.length > 0 ? nonText : undefined
  if (nextSys.length === legacySys.length) {
    const out = sysIn.slice()
    nextSys.forEach((b, i) => {
      out[textIdx[i]!] = toCanonical(b, i)
    })
    return out
  }
  const out = [...nonText, ...nextSys.map(toCanonical)]
  return out.length > 0 ? out : undefined
}

function canonicalSystemToLegacy(b: CanonicalBlock): SystemBlock {
  const text = b.type === "text" ? b.text : ""
  const cache = b.type === "text" ? b.cache : undefined
  if (!cache) return { type: "text", text }
  return {
    type: "text",
    text,
    cache_control: {
      type: "ephemeral",
      ...(cache.ttl ? { ttl: cache.ttl } : {}),
      ...(cache.scope ? { scope: cache.scope } : {}),
    },
  }
}

function legacySystemToCanonical(b: SystemBlock): CanonicalBlock {
  const cc = b.cache_control
  if (!cc) return { type: "text", text: b.text }
  return {
    type: "text",
    text: b.text,
    cache: {
      kind: "ephemeral",
      ...(cc.ttl ? { ttl: cc.ttl } : {}),
      ...(cc.scope ? { scope: cc.scope } : {}),
    },
  }
}
