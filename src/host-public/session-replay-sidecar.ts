/**
 * Narrow public re-export of src/agent/turn-attachments.ts's EXPORT half:
 * `parseReplaySidecarTasks` only, used by `--resume` task-sidecar preview
 * rendering (S34 exports-gap decision, Phase 0 / Bucket C).
 *
 * The PORT half of that file (`instantiateTurnAttachments` /
 * `combineTurnDrains`) is already folded into `build-agent-core.ts`
 * (S34 Y4) and is unrelated to this export.
 *
 * It also exports the replay renderer registry and its shared types
 * (`plugins/loader/replay-renderer-registry.ts`). The plugin loader
 * registers plugin replay renderers there, and a host replay path reads
 * them from the same registry.
 *
 * @module host-public/session-replay-sidecar
 */
export { parseReplaySidecarTasks } from "../agent/turn-attachments.ts"
export {
  clearReplayRenderers,
  type DerivedDisplay,
  getReplayRenderer,
  type ReplaySidecarTask,
  type ReplayToolRenderer,
  type ReplayToolRenderInput,
  registerReplayRenderer,
} from "../plugins/loader/replay-renderer-registry.ts"
