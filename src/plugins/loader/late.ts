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
