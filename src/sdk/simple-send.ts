/**
 * Single round-trip text send (no tools) shared by Agent / AgentCore.
 *
 * @module sdk/simple-send
 */

import { withRollingCacheBreakpoint } from "../agent/cache.ts"
import { createReflectionAckStripper } from "../agent/reflection-ack-stripper.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { CacheTtl } from "../cache/cache-ttl.ts"
import type { Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import type { NetworkClient } from "../network/index.ts"

import { outputConfigSpread } from "./output-config.ts"

export interface SimpleSendHost {
  messages: Message[]
  auth: AuthResult
  model: string
  sendFn: TransportFn
  networkClient?: NetworkClient
  effort?: string
  outputSchema?: object
  speed: "normal" | "fast"
  serviceTier?: string
  thinkingDisplay?: "summarized" | "omitted"
  cacheTtl: CacheTtl
  resolveMaxOutputTokens(): number | undefined
}

/**
 * Append a user turn and stream one assistant reply (no tools advertised).
 *
 * @yields Text chunks from the transport.
 */
export async function* simpleSend(
  host: SimpleSendHost,
  userText: string,
  opts?: Partial<SendOptions>,
): AsyncGenerator<string, StreamedResponse, undefined> {
  host.messages.push({
    role: "user",
    content: [{ type: "text", text: userText }],
  })

  const sendMaxTokens = host.resolveMaxOutputTokens()
  const gen = host.sendFn({
    auth: host.auth,
    messages: withRollingCacheBreakpoint(host.messages, host.cacheTtl),
    model: host.model,
    ...(host.networkClient ? { networkClient: host.networkClient } : {}),
    ...(sendMaxTokens !== undefined ? { maxTokens: sendMaxTokens } : {}),
    ...outputConfigSpread({ effort: host.effort, outputSchema: host.outputSchema }),
    ...(host.speed === "fast" ? { speed: "fast" as const } : {}),
    ...(host.serviceTier ? { serviceTier: host.serviceTier } : {}),
    ...(host.thinkingDisplay
      ? { thinking: { type: "adaptive" as const, display: host.thinkingDisplay } }
      : {}),
    ...opts,
  })

  let response: StreamedResponse | undefined
  const ackStripper = createReflectionAckStripper()
  while (true) {
    const { done, value } = await gen.next()
    if (done) {
      response = value as unknown as StreamedResponse
      const tail = ackStripper.flush()
      if (tail.length > 0) yield tail
      break
    }
    const cleaned = ackStripper.write(value)
    if (cleaned.length > 0) yield cleaned
  }

  const result = response ?? { blocks: [], text: "", stopReason: null }
  if (result.blocks.length > 0) {
    host.messages.push({ role: "assistant", content: result.blocks })
  }
  return result
}
