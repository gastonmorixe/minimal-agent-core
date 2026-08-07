import type { ContentBlock, Message } from "../llm/messages.ts"

/**
 * Append a user turn, coalescing with a trailing user message so roles keep
 * alternating. Tool results stay ahead of every other block as required by
 * block-based provider APIs. Mutates `messages` in place.
 */
export function appendUserTurn(messages: Message[], content: ContentBlock[]): void {
  const last = messages[messages.length - 1]
  if (last?.role === "user" && Array.isArray(last.content)) {
    const toolResults = last.content.filter((block) => block.type === "tool_result")
    const rest = last.content.filter((block) => block.type !== "tool_result")
    last.content = [...toolResults, ...rest, ...content]
  } else {
    messages.push({ role: "user", content })
  }
}
