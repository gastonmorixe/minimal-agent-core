/**
 * Host-owned `/compact` slash command.
 *
 * Not a plugin: the handler needs a live agent with `compact()` (legacy
 * {@link Agent} or {@link AgentCore}). Registered into the CommandRegistry
 * after the agent is constructed so slash-menu / `hasCommand` /
 * `dispatchCommand` all see it.
 *
 * Manual path blocks: `invoke` awaits `compact()` before it returns the
 * user message. No fire-forget.
 *
 * Arg parsing lives in {@link parseCompactArgs} (agent/context-compact):
 * this module only applies host defaults (`local`, `DEFAULT_KEEP_TAIL`).
 *
 * @module host/commands/compact
 */

import {
  type CompactRequestOpts,
  type CompactStats,
  DEFAULT_KEEP_TAIL,
  parseCompactArgs,
} from "../../agent/context-compact.ts"
import { GLOBAL_STATUS_BUS, type StatusBus, type StatusHandle } from "../../bus/status.ts"
import type { CommandContext, ResolvedCommand } from "../../plugins/types.ts"

/** Minimal agent surface the host command needs. */
export interface CompactAgentLike {
  compact?(opts?: CompactRequestOpts): Promise<CompactStats>
}

/**
 * Build a {@link ResolvedCommand} for `/compact` bound to `agent`.
 *
 * `pluginId` is `"host"` so the menu/diagnostics can distinguish it from
 * plugin-contributed commands.
 */
export function createCompactHostCommand(agent: CompactAgentLike): ResolvedCommand {
  return {
    pluginId: "host",
    packageDir: "",
    entryAbsolute: "",
    spec: {
      name: "compact",
      summary: "Compact model-facing context (remote provider API or local checkpoint)",
      argHint: '[mode] [tail=N] [focus="..."]',
      handler: { type: "module", path: "", export: "default" },
    },
    invoke: async (ctx: CommandContext) => {
      if (typeof agent.compact !== "function") {
        return {
          kind: "error",
          message: "/compact is unavailable on this agent (no compact method).",
        }
      }
      const parsed = parseCompactArgs(ctx.argv ?? "")
      if (parsed.error) {
        return { kind: "error", message: parsed.error }
      }
      const mode = parsed.mode ?? "local"
      const keepTail = parsed.keepTail ?? DEFAULT_KEEP_TAIL
      const focus = parsed.focus?.trim() ? parsed.focus : undefined
      // Visible progress while the summary LLM call runs. CommandContext
      // carries no status bus, so prefer a runtime-attached one and fall
      // back to the global bus (same pattern as repl-live-area.ts:963).
      const statusBus: StatusBus | undefined =
        (ctx as unknown as { statusBus?: StatusBus }).statusBus ?? GLOBAL_STATUS_BUS
      let compactStatus: StatusHandle | undefined
      try {
        compactStatus = statusBus?.create("Compacting context", {
          notificationId: "agent.compact",
          category: "agent",
        })
      } catch {
        compactStatus = undefined
      }
      try {
        const stats = await agent.compact({
          reason: "manual",
          mode,
          keepTail,
          ...(focus ? { focus } : {}),
        })
        const lines = [
          `✓ compact (${stats.kind}): ${stats.messagesBefore} → ${stats.messagesAfter} messages`,
        ]
        if (mode !== "local" || keepTail !== DEFAULT_KEEP_TAIL) {
          lines.push(`  mode: ${mode}, tail: ${keepTail}`)
        }
        if (focus) {
          lines.push(`  focus: ${focus}`)
        }
        // Make silent remote→local fallback visible in the TUI (plan-auth
        // wrong-host 401 used to look like a successful "local" compact).
        if (stats.kind === "local" && stats.remoteError) {
          lines.push(`  remote unavailable: ${stats.remoteError}`)
        }
        return { kind: "notice", lines }
      } catch (e) {
        return {
          kind: "error",
          message: `compact failed: ${e instanceof Error ? e.message : String(e)}`,
        }
      } finally {
        try {
          compactStatus?.clear()
        } catch {
          // Status UX must never fail the command result.
        }
      }
    },
  }
}

/**
 * Register `/compact` on the loader when present. No-op when `loader` is
 * null (plugins disabled). Returns whether registration succeeded.
 */
export function registerCompactHostCommand(
  loader: { registerHostCommand(cmd: ResolvedCommand): boolean } | null | undefined,
  agent: CompactAgentLike,
): boolean {
  if (!loader) return false
  return loader.registerHostCommand(createCompactHostCommand(agent))
}
