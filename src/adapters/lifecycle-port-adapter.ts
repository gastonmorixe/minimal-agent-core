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
import { PolicyHookFailedError, type PolicyHookFailure } from "../sdk/policy-hook-failed.ts"
import type { ToolDidInvokePayload } from "../sdk/tool-lifecycle.ts"

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
    return this.emitChain("turn.willStart", payload, false)
  }

  /**
   * Emit `turn.willStop`. A real halt continues the turn. A `failClosed`
   * listener that throws or times out (or a broken emit) ends the turn: the
   * safe side of a stop gate is to stop, not to hold the turn open.
   * `signal` (the turn signal) goes to the chain, so each listener gets it
   * in `ctx.abort`.
   */
  async beforeTurnStop(payload: TurnWillStopPayload, signal?: AbortSignal) {
    try {
      const bus = this.hooks.hookBus
      if (typeof bus.listenerCount === "function" && bus.listenerCount("turn.willStop") === 0) {
        return allowDecision(payload)
      }
      const emitted = await this.hooks.emitChain<TurnWillStopPayload>(
        "turn.willStop",
        payload,
        signal ? { signal } : undefined,
      )
      if (emitted.failed) return allowDecision(payload)
      // A halt with no reason gives reason "": the stop gate fills the
      // runtime.hook_denied text.
      return chainResultToDecision(emitted, "")
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
    return this.emitChain("message.willSend", payload, false)
  }

  afterSend(payload: SendSnapshot): void {
    this.safeAsync("message.didSend", payload)
  }

  async beforeTool(payload: ToolWillInvokePayload) {
    // A halt with no reason gives reason "", and a failed or broken
    // approval gate throws. The tool round fills both texts
    // (tool_result.policy_denied, tool_result.policy_hook_failed).
    return this.emitChain("tool.willInvoke", payload, true)
  }

  /**
   * A failClosed listener failed: throw its facts, so the tool round denies
   * with the `tool_result.policy_hook_failed` text (label and detail).
   */
  private static throwFailure(emitted: { failed?: boolean; failure?: PolicyHookFailure }): void {
    if (emitted.failed === true && emitted.failure) {
      throw new PolicyHookFailedError(emitted.failure.label, emitted.failure.detail)
    }
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

  async afterToolBatch(payload: ToolDidBatchPayload, signal?: AbortSignal) {
    return this.emitChain("tool.didBatch", payload, false, signal)
  }

  async beforeCompact(payload: CompactWillRunPayload) {
    return this.emitChain("compact.willRun", payload, false)
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
    return this.emitChain("subagent.willSpawn", payload, false)
  }

  /**
   * Emit a policy chain and map it to a decision. A halt is a deny (the
   * `action`, never the reason text decides). Core writes no deny text: the
   * reason is the listener's reason or "", and the deny carries the facts
   * `pluginId` (the halting listener) and `failure` (a failed approval
   * listener) for the host to render. With `throwFailure`, a failed or
   * broken approval gate throws instead, so the caller owns the text.
   */
  private async emitChain<T>(
    channel: string,
    payload: T,
    throwFailure: boolean,
    signal?: AbortSignal,
  ): Promise<PolicyDecision<T>> {
    try {
      if (
        typeof this.hooks.hookBus.listenerCount === "function" &&
        this.hooks.hookBus.listenerCount(channel) === 0
      ) {
        return allowDecision(payload)
      }
      const emitted = await this.hooks.emitChain<T>(
        channel,
        payload,
        signal ? { signal } : undefined,
      )
      if (throwFailure) LifecyclePortAdapter.throwFailure(emitted)
      const decision = chainResultToDecision(emitted)
      if (decision.action === "allow") return decision
      if (emitted.haltedBy !== undefined) decision.pluginId = emitted.haltedBy
      if (emitted.failed === true) {
        decision.failure = emitted.failure ?? { detail: "" }
      }
      return decision
    } catch (e) {
      // An approval gate (a `failClosed` listener) is on this channel:
      // a broken emit must deny, never allow.
      if (e instanceof PolicyHookFailedError) throw e
      if (this.failClosedCount(channel) > 0) {
        // The caller owns the text: rethrow so it can deny with it.
        if (throwFailure) throw e
        const detail = e instanceof Error ? e.message : String(e)
        const denied: PolicyDecision<T> = {
          action: "deny",
          reason: "",
          payload,
          failure: { detail },
        }
        return denied
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
