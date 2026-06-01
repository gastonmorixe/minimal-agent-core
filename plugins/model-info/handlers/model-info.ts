/**
 * `ModelInfo` tool handler.
 *
 * Reads the agent's CURRENT model snapshot from the plugin context
 * ({@link TUIContext.queryModelInfo}) and formats a compact, model-facing
 * report. Fully decoupled: it imports no provider and no host registry, only
 * the author-facing context type. The host computes the snapshot live, so this
 * is correct across mid-session model/provider switches and resume.
 *
 * @module plugins/model-info/handlers/model-info
 */

import type { ModelInfoSnapshot, TUIContext, TUIResult } from "../../../src/plugins/types.ts"

const n = (x: number): string => x.toLocaleString("en-US")

function report(info: ModelInfoSnapshot, ctx: TUIContext): string {
  const m = info.modalities
  const accepts = ["text"]
  if (m.image) accepts.push(`images (${(info.acceptedInput.images ?? []).join(", ")})`)
  if (m.pdf) accepts.push(`documents (${(info.acceptedInput.documents ?? []).join(", ")})`)
  if (m.audio) accepts.push("audio")
  if (m.video) accepts.push("video")
  const notAccepted = [
    !m.image && "images",
    !m.pdf && "documents",
    !m.audio && "audio",
    !m.video && "video",
  ].filter(Boolean) as string[]

  const think = [
    info.thinking.adaptive && "adaptive",
    info.thinking.extended && "extended",
    info.thinking.visible && "visible",
    info.thinking.interleaved && "interleaved",
  ].filter(Boolean)

  const cacheBits = [
    info.caching.explicit && "explicit",
    info.caching.automatic && "automatic",
  ].filter(Boolean)

  const p = info.pricing
  const lines = [
    `Model: ${info.displayName} (id: ${info.modelId})`,
    `Provider: ${info.providerId} · surface: ${info.surfaceId}`,
    info.knowledgeCutoff ? `Knowledge cutoff: ${info.knowledgeCutoff}` : null,
    `Context window: ${n(info.contextWindow)} tokens · max output: ${n(info.maxOutputTokens)} tokens`,
    `Input accepted: ${accepts.join(", ")}`,
    `Input NOT accepted: ${notAccepted.length ? notAccepted.join(", ") : "(none)"}`,
    info.effort.levels.length
      ? `Effort: ${info.effort.levels.join(", ")} (default ${info.effort.default})`
      : null,
    think.length ? `Thinking: ${think.join(", ")}` : null,
    cacheBits.length
      ? `Prompt caching: ${cacheBits.join(" + ")}${info.caching.ttls.length ? ` (ttls: ${info.caching.ttls.join(", ")})` : ""}`
      : null,
    `Tools: user-defined=${info.tools.userDefined}, parallel=${info.tools.parallel}${info.serverTools.length ? `, server=[${info.serverTools.join(", ")}]` : ""}`,
    `Pricing /Mtok (USD): in $${p.inputPerMTok}, out $${p.outputPerMTok}, cache-write $${p.cacheWritePerMTok}, cache-read $${p.cacheReadPerMTok}`,
    info.resolved ? null : "(note: this model id is not registered; values are conservative defaults)",
    ctx.agent ? `Session: ${ctx.agent.sessionId} · agent v${ctx.agent.version}` : null,
    `Working directory: ${ctx.cwd}`,
  ].filter(Boolean) as string[]
  return lines.join("\n")
}

export default async function modelInfo(ctx: TUIContext): Promise<TUIResult> {
  const info = ctx.queryModelInfo?.()
  if (!info) {
    return {
      kind: "tool_result",
      content:
        "Current-model capability info is unavailable in this context (no model-info provider wired). The host did not expose ctx.queryModelInfo.",
      is_error: true,
    }
  }
  const content = report(info, ctx)
  return {
    kind: "tool_result",
    content,
    displayHeader: `${info.displayName} · ${info.providerId}`,
  }
}
