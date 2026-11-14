/**
 * Public re-export shim for `@minimal-agent/core/host/system-block-origins`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/system-block-origins.ts`: the
 * slot spans of the core system-prompt blocks, read by block text. The
 * record function stays internal to core.
 *
 * @module host-public/system-block-origins
 */

export {
  describeSystemBlock,
  type SystemSlotId,
  type SystemSlotSpan,
} from "../llm/system-block-origins.ts"
