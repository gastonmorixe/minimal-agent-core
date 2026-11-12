/**
 * Process-wide slot for the system prompt base holder. The plugin loader
 * stores its holder here. The prompt builders read it lazily and fall back to
 * the core defaults when the slot is empty. Holds no prompt text.
 *
 * @module llm/system-prompt-base-registry
 */

import type { SystemPromptBaseHolder } from "../plugins/system-prompt-base.ts"

/** The stored holder and the token of the writer that stored it. */
interface Slot {
  owner: symbol
  holder: SystemPromptBaseHolder
}

let slot: Slot | undefined

/**
 * Store `holder` as the process-wide holder. Replaces any earlier holder.
 * Returns a release function. The release clears the slot only when the slot
 * still has the owner of this call, so a stale release does nothing.
 */
export function setSystemPromptBase(holder: SystemPromptBaseHolder): () => void {
  const owner = Symbol("system-prompt-base")
  slot = { owner, holder }
  return () => {
    if (slot?.owner === owner) slot = undefined
  }
}

/**
 * The current holder, or undefined when none is set.
 * An EMPTY provider part "" overrides the default: the caller does not fall back to the core text.
 */
export function getSystemPromptBase(): SystemPromptBaseHolder | undefined {
  return slot?.holder
}

/** Drop the holder. Tests only. */
export function clearSystemPromptBase(): void {
  slot = undefined
}
