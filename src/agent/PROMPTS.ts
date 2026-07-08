import { promptPath, renderPrompt } from "../prompts/prompts.ts"

function runtimePrompt(
  file: string,
  vars?: Record<string, string | number | boolean | null | undefined>,
): string {
  return renderPrompt(promptPath(import.meta, "..", "prompts", "runtime", file), vars)
}

export function turnAbortedAttachmentText(): string {
  return runtimePrompt("turn-aborted.md")
}

export function outputTruncatedAttachmentText(): string {
  return runtimePrompt("output-truncated.md")
}

export function responseTruncatedPlaceholderText(): string {
  return runtimePrompt("response-truncated-placeholder.md")
}

export function emergencyCapTriggeredAttachmentText(round: number): string {
  return runtimePrompt("emergency-cap-triggered.tmpl.md", { round })
}

export function reflectionCheckpointAttachmentText(round: number, cooldownSec: number): string {
  return runtimePrompt("reflection-checkpoint.tmpl.md", { round, cooldownSec })
}

export function toolExecutionAbortedBeforeCompletionResult(): string {
  return "Tool execution aborted by user before completion."
}
