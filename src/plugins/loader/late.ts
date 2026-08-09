/**
 * Late-bound loader helpers (kept out of loader.ts for max-lines).
 *
 * @module plugins/loader/late
 */

export { CommandRegistry } from "./commands.ts"
export { discoverAndParsePackages } from "./discovery.ts"
export {
  registerEventSub,
  registerHookSub,
  resolveCommand,
  resolveEventSub,
  resolveHookSub,
  resolveLiveAreaSlot,
} from "./event-subs.ts"
export { DEFAULT_FRAGMENT_TIMEOUT_MS, findFragmentDef, startFragment } from "./fragments.ts"
export {
  classifyPluginPrompt,
  escapeTagAttr,
  findPackageDirFor,
  findPluginIdFor,
  PROMPT_ROLE_ORDER,
  type PromptRole,
  pluginToolDefinitionFromTrigger,
  resolveHandler,
  stripLeadingHeading,
} from "./helpers.ts"
export type {
  PendingFragment,
  PluginPromptBlocks,
  PromptFragmentPlacement,
  ResolvedFragment,
} from "./prompt-blocks.ts"
export { groupSessionContextFragments, joinAfterInstructions } from "./prompt-blocks.ts"
export { registerManifestReplayRenderers } from "./replay-renderers.ts"
export { runPluginSetups } from "./setups.ts"
export { registerManifestTurnAttachments } from "./turn-attachments.ts"

import type {
  AgentContext,
  LoadedPlugin,
  ResolvedEventSub,
  ResolvedHandler,
  ResolvedHookSub,
  ResolvedLiveAreaSlot,
  ToolAvailabilityContext,
} from "../types.ts"

import { pluginToolDefinitionFromTrigger } from "./helpers.ts"

/** Build the dynamic context supplied to plugin tool availability predicates. */
export function createToolAvailabilityContext(
  agent: AgentContext | undefined,
): ToolAvailabilityContext {
  return {
    env: { ...process.env } as Record<string, string>,
    cwd: process.cwd(),
    ...(agent ? { agent } : {}),
  }
}

/** Evaluate a plugin tool availability predicate, failing open on handler errors. */
export function isPluginToolAvailable(
  handler: ResolvedHandler,
  context: ToolAvailabilityContext,
  logger: (message: string) => void,
): boolean {
  if (!handler.available) return true
  try {
    return handler.available(context) !== false
  } catch (error) {
    const name =
      handler.definition.trigger.type === "tool"
        ? handler.definition.trigger.tool.name
        : handler.definition.id
    logger(
      `tool availability predicate threw for "${name}"; keeping the tool visible: ${error instanceof Error ? error.message : String(error)}`,
    )
    return true
  }
}

/** Collect model-visible plugin tools after evaluating dynamic availability. */
export function collectPluginTools(
  plugins: LoadedPlugin[],
  context: ToolAvailabilityContext,
  logger: (message: string) => void,
) {
  const out = []
  for (const pkg of plugins) {
    for (const handler of pkg.handlers) {
      if (
        handler.definition.trigger.type !== "tool" ||
        !isPluginToolAvailable(handler, context, logger)
      )
        continue
      const tool = handler.definition.trigger.tool
      out.push({
        ...pluginToolDefinitionFromTrigger(tool),
        ...(handler.definition.icon ? { icon: handler.definition.icon } : {}),
        ...(handler.definition.color ? { color: handler.definition.color } : {}),
        ...(handler.definition.headerKey ? { headerKey: handler.definition.headerKey } : {}),
      })
    }
  }
  return out
}

/** Flatten resolved event subscriptions with their plugin owners. */
export function collectEventSubscriptions(
  plugins: LoadedPlugin[],
): Array<{ pluginId: string; sub: ResolvedEventSub }> {
  return plugins.flatMap((pkg) => pkg.eventSubs.map((sub) => ({ pluginId: pkg.manifest.id, sub })))
}

/** Flatten resolved hook subscriptions with their plugin owners. */
export function collectHookSubscriptions(
  plugins: LoadedPlugin[],
): Array<{ pluginId: string; sub: ResolvedHookSub }> {
  return plugins.flatMap((pkg) => pkg.hookSubs.map((sub) => ({ pluginId: pkg.manifest.id, sub })))
}

/** Flatten all resolved live-area slot declarations. */
export function collectLiveAreaSlots(plugins: LoadedPlugin[]): ResolvedLiveAreaSlot[] {
  return plugins.flatMap((pkg) => pkg.liveAreaSlots)
}
