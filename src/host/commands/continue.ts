/**
 * Host-owned `/continue` slash command.
 *
 * Not a plugin: the handler needs a live agent with `noteSessionResumed()`
 * (legacy {@link Agent} or {@link AgentCore}). Registered into the
 * CommandRegistry after the agent is constructed so slash-menu /
 * `hasCommand` / `dispatchCommand` all see it.
 *
 * @module host/commands/continue
 */

import type { ResolvedCommand } from "../../plugins/types.ts"

/** Minimal agent surface the host command needs. */
export interface ContinueAgentLike {
  noteSessionResumed(): void
}

/**
 * Build a {@link ResolvedCommand} for `/continue` bound to `agent`.
 *
 * `pluginId` is `"host"` so the menu/diagnostics can distinguish it from
 * plugin-contributed commands.
 */
export function createContinueHostCommand(agent: ContinueAgentLike): ResolvedCommand {
  return {
    pluginId: "host",
    packageDir: "",
    entryAbsolute: "",
    spec: {
      name: "continue",
      summary: "Resume incomplete work from where the session left off",
      handler: { type: "module", path: "", export: "default" },
    },
    invoke: async () => {
      agent.noteSessionResumed()
      return {
        kind: "expand",
        prompt: "",
      }
    },
  }
}

/**
 * Register `/continue` on the loader when present. No-op when `loader`
 * is null (plugins disabled). Returns whether registration succeeded.
 */
export function registerContinueHostCommand(
  loader: { registerHostCommand(cmd: ResolvedCommand): boolean } | null | undefined,
  agent: ContinueAgentLike,
): boolean {
  if (!loader) return false
  return loader.registerHostCommand(createContinueHostCommand(agent))
}
