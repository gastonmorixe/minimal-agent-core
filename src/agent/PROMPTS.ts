import { promptPath, renderPrompt } from "../prompts/prompts.ts"

function runtimePrompt(
  file: string,
  vars?: Record<string, string | number | boolean | null | undefined>,
): string {
  return renderPrompt(promptPath(import.meta, "..", "prompts", "runtime", file), vars)
}

/** Returns the attachment text injected when a turn is aborted by the user. */
export function turnAbortedAttachmentText(): string {
  return runtimePrompt("turn-aborted.md")
}

/** Returns the attachment text injected when tool output was truncated. */
export function outputTruncatedAttachmentText(): string {
  return runtimePrompt("output-truncated.md")
}

/**
 * Attachment injected after salvaging complete tool calls from a
 * terminal-less stream close. Tells the model not to re-issue those tools.
 */
export function streamInterruptedAttachmentText(): string {
  return runtimePrompt("stream-interrupted.md")
}

/** Returns the placeholder text used when an assistant response is truncated. */
export function responseTruncatedPlaceholderText(): string {
  return runtimePrompt("response-truncated-placeholder.md")
}

/** Returns the attachment text injected when the emergency round cap triggers. */
export function emergencyCapTriggeredAttachmentText(round: number): string {
  return runtimePrompt("emergency-cap-triggered.tmpl.md", { round })
}

/** Returns the attachment text for a reflection checkpoint at a given round and cooldown. */
export function reflectionCheckpointAttachmentText(round: number, cooldownSec: number): string {
  return runtimePrompt("reflection-checkpoint.tmpl.md", { round, cooldownSec })
}

/** Returns the tool-result string for a tool aborted by the user before completion. */
export function toolExecutionAbortedBeforeCompletionResult(): string {
  return "Tool execution aborted by user before completion."
}
