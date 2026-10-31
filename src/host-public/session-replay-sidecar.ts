/**
 * Narrow public re-export of src/agent/turn-attachments.ts's EXPORT half:
 * `parseReplaySidecarTasks` only, used by `--resume` task-sidecar preview
 * rendering (S34 exports-gap decision, Phase 0 / Bucket C).
 *
 * The PORT half of that file (`instantiateTurnAttachments` /
 * `combineTurnDrains`) is already folded into `build-agent-core.ts`
 * (S34 Y4) and is unrelated to this export.
 *
 * @module host-public/session-replay-sidecar
 */
export { parseReplaySidecarTasks } from "../agent/turn-attachments.ts"
