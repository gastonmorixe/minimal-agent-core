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
} from "./event-subs.ts"
export { DEFAULT_FRAGMENT_TIMEOUT_MS, findFragmentDef, startFragment } from "./fragments.ts"
export {
  classifyPluginPrompt,
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
  PromptFragmentSpan,
  PromptProvenance,
  ResolvedFragment,
  SessionContextSection,
  ToolOwner,
} from "./prompt-blocks.ts"
export {
  afterInstructionsSpans,
  groupSessionContextFragments,
  joinAfterInstructions,
} from "./prompt-blocks.ts"
export { registerManifestReplayRenderers } from "./replay-renderers.ts"
export { runPluginSetups } from "./setups.ts"
export { registerManifestTurnAttachments } from "./turn-attachments.ts"

import type { PromptExpander } from "../prompt-expand.ts"
import type {
  AgentContext,
  LoadedPlugin,
  ResolvedEventSub,
  ResolvedHandler,
  ResolvedHookSub,
  ToolAvailabilityContext,
} from "../types.ts"

import { pluginToolDefinitionFromTrigger } from "./helpers.ts"
import type { ToolOwner } from "./prompt-blocks.ts"

/**
 * Map each plugin tool name to its owner plugin. Reads `pkg.handlers`, so
 * it holds the canonical names (set at load) and the dynamic tools
 * (pushed by `registerDynamicTools`). Core tools are never in it.
 */
export function collectToolOwners(plugins: readonly LoadedPlugin[]): Map<string, ToolOwner> {
  const out = new Map<string, ToolOwner>()
  for (const pkg of plugins) {
    for (const h of pkg.handlers) {
      if (h.definition.trigger.type !== "tool") continue
      const name = h.definition.trigger.tool.name
      if (!out.has(name)) out.set(name, { pluginId: pkg.manifest.id, packageDir: pkg.packageDir })
    }
  }
  return out
}

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
  expand?: PromptExpander,
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
      // S6 (design 50 §2): the tool text is static prompt text.
      out.push(pluginToolDefinitionFromTrigger(tool, expand))
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
