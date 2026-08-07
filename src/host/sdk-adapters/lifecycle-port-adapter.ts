/**
 * Host adapter: bind the plugin {@link Hooks} facade to the SDK
 * {@link LifecyclePort}.
 *
 * AgentCore never imports HookBus; this adapter is the only place that maps
 * port methods onto catalog channels (`tool.willInvoke`, `message.willSend`, …)
 * and translates HookBus `{payload,halt,reason}` into {@link PolicyDecision}.
 *
 * @module host/sdk-adapters/lifecycle-port-adapter
 */

import type { Hooks } from "../../plugins/hooks/hooks.ts"
import {
  allowDecision,
  type CompactDidRunPayload,
  type CompactWillRunPayload,
  type CwdDidChangePayload,
  chainResultToDecision,
  type InstructionsDidLoadPayload,
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type PolicyDecision,
  type SendSnapshot,
  type SessionLifecyclePayload,
  type SubagentWillSpawnPayload,
  type ToolDidBatchPayload,
  type ToolWillInvokePayload,
  type TurnEndPayload,
  type TurnWillStartPayload,
} from "../../sdk/lifecycle.ts"
import type { ToolDidInvokePayload } from "../../sdk/tool-lifecycle.ts"

/**
 * Build a {@link LifecyclePort} over a live Hooks facade, or return
 * {@link NOOP_LIFECYCLE} when `hooks` is null/undefined.
 */
export function createLifecyclePort(hooks: Hooks | null | undefined): LifecyclePort {
  if (!hooks) return NOOP_LIFECYCLE
  return new LifecyclePortAdapter(hooks)
}

/**
 * HookBus-backed {@link LifecyclePort}. Each method is best-effort: emit
 * failures fall back to allow / pass-through so a misconfigured channel never
 * bricks the agent loop.
 */
export class LifecyclePortAdapter implements LifecyclePort {
  constructor(private readonly hooks: Hooks) {}

  async beforeTurn(payload: TurnWillStartPayload) {
    return this.emitChain("turn.willStart", payload, "Turn blocked by lifecycle policy hook.")
  }

  async beforeSend(payload: SendSnapshot) {
    return this.emitChain("message.willSend", payload, "Send blocked by lifecycle policy hook.")
  }

  afterSend(payload: SendSnapshot): void {
    this.safeAsync("message.didSend", payload)
  }

  async beforeTool(payload: ToolWillInvokePayload) {
    return this.emitChain("tool.willInvoke", payload, "Tool blocked by lifecycle policy hook.")
  }

  async afterTool(payload: ToolDidInvokePayload): Promise<ToolDidInvokePayload> {
    try {
      if (this.hooks.hookBus.listenerCount("tool.didInvoke") === 0) return payload
      const emitted = await this.hooks.emitChain<ToolDidInvokePayload>("tool.didInvoke", payload)
      return emitted.payload
    } catch {
      return payload
    }
  }

  async afterToolBatch(payload: ToolDidBatchPayload) {
    return this.emitChain("tool.didBatch", payload, "Agentic loop stopped by tool.didBatch hook.")
  }

  async beforeCompact(payload: CompactWillRunPayload) {
    return this.emitChain("compact.willRun", payload, "Compact blocked by lifecycle policy hook.")
  }

  afterCompact(payload: CompactDidRunPayload): void {
    this.safeAsync("compact.didRun", payload)
  }

  sessionStart(payload: SessionLifecyclePayload): void {
    this.safeAsync("agent.willStart", payload)
    this.safeAsync("agent.didStart", payload)
  }

  sessionEnd(payload: SessionLifecyclePayload): void {
    this.safeAsync("agent.willStop", payload)
    this.safeAsync("agent.didStop", payload)
  }

  turnEnd(payload: TurnEndPayload): void {
    if (payload.aborted) {
      this.safeAsync("turn.aborted", payload)
    } else {
      this.safeAsync("turn.didEnd", payload)
    }
  }

  turnFailed(payload: TurnEndPayload): void {
    this.safeAsync("turn.aborted", payload)
  }

  cwdDidChange(payload: CwdDidChangePayload): void {
    this.safeAsync("cwd.didChange", payload)
  }

  instructionsDidLoad(payload: InstructionsDidLoadPayload): void {
    this.safeAsync("instructions.didLoad", payload)
  }

  async beforeSubagentSpawn(payload: SubagentWillSpawnPayload) {
    return this.emitChain(
      "subagent.willSpawn",
      payload,
      "Sub-agent spawn blocked by lifecycle policy hook.",
    )
  }

  private async emitChain<T>(
    channel: string,
    payload: T,
    defaultDenyReason: string,
  ): Promise<PolicyDecision<T>> {
    try {
      if (
        typeof this.hooks.hookBus.listenerCount === "function" &&
        this.hooks.hookBus.listenerCount(channel) === 0
      ) {
        return allowDecision(payload)
      }
      const emitted = await this.hooks.emitChain<T>(channel, payload)
      return chainResultToDecision(emitted, defaultDenyReason)
    } catch {
      return allowDecision(payload)
    }
  }

  private safeAsync(channel: string, payload: unknown): void {
    try {
      this.hooks.emitAsync(channel, payload)
    } catch {
      // Channel missing or shape mismatch — ignore (catalog may lag).
    }
  }
}
