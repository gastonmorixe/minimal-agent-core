/**
 * Host adapter: bind the media-ingest pipeline to the SDK {@link MediaResolver}
 * port.
 *
 * The legacy `Agent` resolves inline `@file` / image references in the user's
 * prompt via `resolveUserTurnContent(userText, { modelId })` and pushes the
 * returned content blocks onto the user turn. This adapter wraps that exact
 * call so an {@link AgentCore} run ingests media identically.
 *
 * The `modelId` matters: media resolution consults the active model's vision
 * capability to decide whether an image is materialized as pixels or dropped
 * with a warning. The adapter captures the model id at construction (the run's
 * model), matching the legacy loop's `{ modelId: this.model }`.
 *
 * @module host/sdk-adapters/media-resolver-adapter
 */

import type { ContentBlock } from "../../llm/messages.ts"
import { resolveUserTurnContent } from "../../media/ingest.ts"
import type { MediaResolver } from "../../sdk/ports.ts"

/**
 * A {@link MediaResolver} over {@link resolveUserTurnContent}.
 *
 * When AgentCore has a media resolver wired, it uses the resolver's blocks as
 * the user turn content in place of a plain `{ type: "text" }` block, so inline
 * attachments are ingested. Without one, the core falls back to a text block —
 * so this adapter only needs to be present when media support is wanted.
 */
export class MediaResolverAdapter implements MediaResolver {
  constructor(private readonly modelId: string) {}

  /**
   * Resolve inline media references in `userText` into content blocks (text
   * plus any materialized images), using the run's model id for vision
   * capability. Delegates verbatim to `resolveUserTurnContent`.
   */
  resolveUserContent(userText: string): Promise<ContentBlock[]> {
    return resolveUserTurnContent(userText, { modelId: this.modelId })
  }
}
