/**
 * Public re-export of src/agent/runtime-attachments.ts
 * (`isRuntimeAttachmentBlock`, `isRuntimeAttachmentText`,
 * `RUNTIME_ATTACHMENT_OPENERS`) — strips the agent runtime's own
 * `<ma::agent::*>` / `<ma::plugin::*>` text blocks from `--resume`
 * scrollback and other display paths (S34 exports-gap decision,
 * Phase 0 / Bucket C).
 *
 * @module host-public/runtime-attachments
 */
export * from "../agent/runtime-attachments.ts"
