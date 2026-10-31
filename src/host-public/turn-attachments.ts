/**
 * Narrow public re-export for `@minimal-agent/core/host/turn-attachments`.
 * It exports the PORT half of `src/agent/turn-attachments.ts`:
 * `instantiateTurnAttachments`, `combineTurnDrains`, and their types. The
 * factory registry functions stay core-only. The plugin loader fills the
 * registry.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * The CLI entry point needs these functions (S34 Phase 3). It makes the
 * plugin producers one time. Then it gives the same producers and drain
 * to each session it opens. `BuildAgentCoreDeps.turnAttachmentContext`
 * makes new producers for each session instead. The interactive session
 * also does not use `build-agent-core.ts`. The registry is module state,
 * so the CLI must call this module, not a copy.
 *
 * @module host-public/turn-attachments
 */

export type {
  TurnAttachmentContext,
  TurnAttachmentProducer,
  TurnContentDrain,
} from "../agent/turn-attachments.ts"
export { combineTurnDrains, instantiateTurnAttachments } from "../agent/turn-attachments.ts"
