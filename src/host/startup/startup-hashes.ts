/**
 * Startup systemHash + toolsHash computation.
 *
 * The session-store meta record is written at session OPEN, before any
 * `agent.run()` call, so the entrypoint must reproduce the exact system-prompt
 * and tools digests the agent would compute on its first turn. Resume drift
 * detection compares these two hashes; if they diverge a warning fires on
 * `--resume`. Split out of `src/index.ts` to keep that file under the
 * `max-lines` lint budget.
 *
 * @module host/startup/startup-hashes
 */

import type { AuthResult } from "../../auth/auth.ts"
import type { CacheTtl } from "../../cache/cache-ttl.ts"
import type { ModeManager } from "../../modes/modes.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { loadBlobStoreConfig } from "../../session/blob-store.ts"
import { shortHash } from "../../session/session-store.ts"
import { TOOL_DEFINITIONS } from "../../tools/tools.ts"

/** Inputs for {@link computeStartupHashes}. */
export interface ComputeStartupHashesInput {
  /** The active plugin loader, or `null` when no plugins loaded. */
  readonly loader: PluginLoader | null
  /** The active mode manager, or `null` when no modes loaded. */
  readonly modeManager: ModeManager | null
  /** Normalized selected model id (no `[1m]`/`[2m]` suffix). */
  readonly selectedModelBase: string
  /** Resolved startup auth (its `type` folds into the system prompt hash). */
  readonly auth: AuthResult
  /** Resolved cache TTL bucket. */
  readonly cacheTtl: CacheTtl
}

/** The two digests stored on the session-store meta record. */
export interface StartupHashes {
  readonly systemHash: string
  readonly toolsHash: string
}

/**
 * Compute the system-prompt and tools digests for the session-store meta
 * record. Mirrors `agent.run()`'s internal recipe (same reflection defaults,
 * same `resolveSystemPromptForModel` call) so resume drift detection compares
 * like with like.
 */
export async function computeStartupHashes(
  input: ComputeStartupHashesInput,
): Promise<StartupHashes> {
  const { loader, modeManager, selectedModelBase, auth, cacheTtl } = input

  const pluginBlock = loader?.getPromptBlock() ?? null
  const modeAddition = modeManager?.systemPromptAddition() ?? ""
  const sessionContextForHash =
    pluginBlock && modeAddition
      ? `${pluginBlock}\n\n${modeAddition}`
      : pluginBlock != null
        ? pluginBlock
        : modeAddition !== ""
          ? modeAddition
          : null

  const { DEFAULT_REFLECTION_INTERVAL, DEFAULT_REFLECTION_COOLDOWN_MS } = await import(
    "../../agent/reflection.ts"
  )
  const { resolveSystemPromptForModel } = await import("../../llm/system-prompt.ts")

  // Resolve blob-store enablement BEFORE the hash so the resume drift detector
  // treats "blob store on" vs "off" as distinct prefix shapes (cheap; the
  // config loader is memoized). The reflection defaults below MUST track the
  // Agent class field defaults in src/agent.ts.
  const blobStoreEnabled = loadBlobStoreConfig().config.enabled
  const systemForHash = sessionContextForHash
    ? JSON.stringify(
        resolveSystemPromptForModel(selectedModelBase, {
          sessionContext: sessionContextForHash,
          reflectionInterval: DEFAULT_REFLECTION_INTERVAL,
          reflectionCooldownMs: DEFAULT_REFLECTION_COOLDOWN_MS,
          maxToolRounds: Number.POSITIVE_INFINITY,
          blobStoreEnabled,
          authKind: auth.type,
          cacheTtl,
        }),
      )
    : ""

  const allToolsForHash = loader
    ? [...TOOL_DEFINITIONS, ...(loader.getExtraTools() as typeof TOOL_DEFINITIONS)]
    : [...TOOL_DEFINITIONS]
  const toolsForHash = JSON.stringify(
    allToolsForHash.map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.input_schema,
    })),
  )

  return {
    systemHash: shortHash(systemForHash),
    toolsHash: shortHash(toolsForHash),
  }
}
