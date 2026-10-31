/**
 * Narrow public re-export for `@minimal-agent/core/host/model-info`. It
 * exports only the two ModelInfo-tool data builders from
 * `src/llm/model-info.ts`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * The CLI entry point needs these builders (S34 Phase 3). It gives the
 * loader its ModelInfo closures before the interactive session exists.
 * That session opens through `runtime.openSession` directly. Thus
 * `BuildAgentCoreDeps.wireModelInfoSource` does not run for it. Also,
 * `--host-mode` must make a snapshot for any registered model id, not
 * only for the live model.
 *
 * @module host-public/model-info
 */

export { buildModelInfoSnapshot, buildSubagentModelRecommendations } from "../llm/model-info.ts"
