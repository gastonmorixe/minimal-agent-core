/**
 * Host adapter: bind the plugin {@link Hooks} facade to the SDK
 * {@link LifecyclePort}.
 *
 * AgentCore never imports HookBus; this adapter is the only place that maps
 * port methods onto catalog channels (`tool.willInvoke`, `message.willSend`, …)
 * and translates HookBus `{payload,halt,reason}` into {@link PolicyDecision}.
 *
 * @module adapters/lifecycle-port-adapter
 */

import type { Hooks } from "../plugins/hooks/hooks.ts"
import { cleanHookContext } from "../sdk/hook-context.ts"
import {
  allowDecision,
  type CompactDidRunPayload,
  type CompactWillRunPayload,
  type CwdDidChangePayload,
  chainResultToDecision,
  denyDecision,
  type HookContextEntry,
  type InstructionsDidLoadPayload,
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type PolicyDecision,
  type SendSnapshot,
  type SessionLifecyclePayload,
  type SessionWillStartPayload,
  type SubagentWillSpawnPayload,
  type ToolDidBatchPayload,
  type ToolDidInvokeResult,
  type ToolWillInvokePayload,
  type TurnEndPayload,
  type TurnWillStartPayload,
  type TurnWillStopPayload,
} from "../sdk/lifecycle.ts"
import type { ToolDidInvokePayload } from "../sdk/tool-lifecycle.ts"
import { DEFAULT_STOP_HOOK_REASON } from "../sdk/turn-stop-hook.ts"

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

  /**
   * Emit `turn.willStop`. A real halt continues the turn. A `failClosed`
   * listener that throws or times out (or a broken emit) ends the turn: the
   * safe side of a stop gate is to stop, not to hold the turn open.
   */
  async beforeTurnStop(payload: TurnWillStopPayload) {
    try {
      const bus = this.hooks.hookBus
      if (typeof bus.listenerCount === "function" && bus.listenerCount("turn.willStop") === 0) {
        return allowDecision(payload)
      }
      const emitted = await this.hooks.emitChain<TurnWillStopPayload>("turn.willStop", payload)
      if (emitted.failed) return allowDecision(payload)
      return chainResultToDecision(emitted, DEFAULT_STOP_HOOK_REASON)
    } catch {
      return allowDecision(payload)
    }
  }

  /** Emit `session.willStart`. A halt is ignored. Only the listener context is kept. */
  async sessionWillStart(
    payload: SessionWillStartPayload,
  ): Promise<{ additionalContext: HookContextEntry[] }> {
    try {
      if (this.hooks.hookBus.listenerCount("session.willStart") === 0) {
        return { additionalContext: [] }
      }
      const emitted = await this.hooks.emitChain<SessionWillStartPayload>(
        "session.willStart",
        payload,
      )
      return { additionalContext: [...(emitted.additionalContext ?? [])] }
    } catch {
      return { additionalContext: [] }
    }
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

  hasFailClosedToolHook(): boolean {
    return this.failClosedCount("tool.willInvoke") > 0
  }

  async afterTool(payload: ToolDidInvokePayload): Promise<ToolDidInvokeResult> {
    try {
      if (this.hooks.hookBus.listenerCount("tool.didInvoke") === 0) return payload
      const emitted = await this.hooks.emitChain<ToolDidInvokePayload>("tool.didInvoke", payload)
      // Position does not count on a tool channel: keep only the entry texts.
      const ctx = cleanHookContext(emitted.additionalContext)
      return ctx.length > 0 ? { ...emitted.payload, additionalContext: ctx } : emitted.payload
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
    } catch (e) {
      // An approval gate (a `failClosed` listener) is on this channel:
      // a broken emit must deny, never allow.
      if (this.failClosedCount(channel) > 0) {
        const msg = e instanceof Error ? e.message : String(e)
        return denyDecision(`${defaultDenyReason} The approval hook failed (${msg}).`, payload)
      }
      return allowDecision(payload)
    }
  }

  private failClosedCount(channel: string): number {
    const bus = this.hooks.hookBus
    return typeof bus.failClosedCount === "function" ? bus.failClosedCount(channel) : 0
  }

  private safeAsync(channel: string, payload: unknown): void {
    try {
      this.hooks.emitAsync(channel, payload)
    } catch {
      // Channel missing or shape mismatch — ignore (catalog may lag).
    }
  }
}
