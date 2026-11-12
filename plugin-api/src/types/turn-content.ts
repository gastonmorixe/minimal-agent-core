/**
 * Turn content provider contract (G2, R-API-5).
 *
 * A plugin supplies content blocks core adds to a user message at two seams:
 * the start of a turn and after each tool round. Core holds no such text.
 *
 * The return type is `ContentBlock` only. The sideband half of the spec union
 * (`SidebandOrBlock`) is added when the sideband types land.
 *
 * @module types/turn-content
 */

import type { TextBlock } from "../llm/canonical-messages.ts"

/**
 * The block kinds a provider may return. plugin-api cannot import the core
 * `ContentBlock` (leaf rule) and the canonical image shape differs, so S3.1
 * allows text blocks only. Other kinds join when the shapes are unified.
 */
export type ContentBlock = TextBlock

/** Facts core passes to a provider on each call. */
export interface TurnContentCtx {
  readonly seam: "initial" | "round"
  readonly round: number
  readonly previousTurn: "aborted" | "resumed" | null
  readonly salvaged: boolean
  readonly resumingFromCheckpoint: boolean
  readonly modeChange?: { readonly from: string; readonly to: string; readonly at: string }
}

/**
 * One provider. Providers run in ascending `order`, ties by registration
 * order. An empty result adds nothing. A throw skips the provider.
 */
export interface TurnContentProviderDecl {
  readonly order: number
  provide(ctx: TurnContentCtx): readonly ContentBlock[] | Promise<readonly ContentBlock[]>
}
