/**
 * Startup systemHash + toolsHash computation.
 *
 * The session-store meta record is written at session OPEN, before any
 * `agent.run()` call, so the entrypoint must reproduce the exact system-prompt
 * and tools digests the agent would compute on its first turn. Resume drift
 * detection compares these two hashes; if they diverge a warning fires on
 * `--resume`. Split out of the host entry point to keep that file under the
 * `max-lines` lint budget.
 *
 * @module session/startup-hashes
 */

import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { CacheTtl } from "../cache/cache-ttl.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import type { SystemPromptBaseHolder } from "../plugins/system-prompt-base.ts"
import { applyToolNamePolicy, type ToolNamePolicy } from "../sdk/tool-filter.ts"
import { buildToolDefinitions } from "../tools/tool-definitions.ts"
import type { ToolDefinition } from "../tools/tools.ts"

import { shortHash } from "./session-store.ts"

/** Inputs for {@link computeStartupHashes}. */
export interface ComputeStartupHashesInput {
  /** The active plugin loader, or `null` when no plugins loaded. */
  readonly loader: PluginLoader | null
  /** The active mode manager, or `null` when no modes loaded. */
  readonly modeManager: ModeManager | null
  /**
   * Advertisement-time tool name policy (CLI `--tools` / `--no-tools`).
   * Tools hash digests the same set the model will see.
   */
  readonly toolNamePolicy?: ToolNamePolicy
  /** Normalized selected model id (no `[1m]`/`[2m]` suffix). */
  readonly selectedModelBase: string
  /** Provider selected at boot, for provider-scoped prompt resolution. */
  readonly selectedProviderId?: string
  /** Resolved startup auth (its `type` folds into the system prompt hash). */
  readonly auth: AuthResult
  /** Resolved cache TTL bucket. */
  readonly cacheTtl: CacheTtl
  /** Resolved system-prompt overrides from CLI/env/config. */
  readonly systemPromptOverrides?: SystemPromptOverrides
  /**
   * Built-in tool text providers. Default: the loader's
   * `toolTextProviders()`. An explicit value wins.
   */
  readonly toolTextProviders?: readonly ToolTextProvider[]
}

/** The two digests stored on the session-store meta record. */
export interface StartupHashes {
  readonly systemHash: string
  readonly toolsHash: string
}

/**
 * Compute the system-prompt and tools digests for the session-store meta
 * record. Mirrors `agent.run()`'s internal recipe (the same
 * `resolveSystemPromptForModel` call) so resume drift detection compares
 * like with like.
 */
export async function computeStartupHashes(
  input: ComputeStartupHashesInput,
): Promise<StartupHashes> {
  const {
    loader,
    modeManager,
    toolNamePolicy = null,
    selectedModelBase,
    selectedProviderId,
    auth,
    cacheTtl,
    systemPromptOverrides,
    toolTextProviders,
  } = input

  // sessionContext for hash stays SYNC (`getPromptBlock`): PROMPT.md only,
  // no async fragments — volatile env-info must not false-fire resume drift.
  // afterInstructions (file-based plain guidance) comes from the async dual
  // API when available so it participates in systemHash without pulling
  // sessionContext fragments into the hash.
  const loaderAny = loader as
    | {
        getPromptBlocksAsync?: () => Promise<{
          afterInstructions: string | null
          sessionContext: string | null
        }>
        getPromptBlock?: () => string | null
        systemPromptBase?: () => SystemPromptBaseHolder
      }
    | null
    | undefined
  let afterInstructionsForHash: string | null = null
  if (loaderAny && typeof loaderAny.getPromptBlocksAsync === "function") {
    afterInstructionsForHash = (await loaderAny.getPromptBlocksAsync()).afterInstructions
  }
  const sessionPluginBlock = loaderAny?.getPromptBlock?.() ?? null
  const modeAddition = modeManager?.systemPromptAddition() ?? ""
  const sessionContextForHash =
    sessionPluginBlock && modeAddition
      ? `${sessionPluginBlock}\n\n${modeAddition}`
      : sessionPluginBlock != null
        ? sessionPluginBlock
        : modeAddition !== ""
          ? modeAddition
          : null

  const { resolveSystemPromptForModel } = await import("../llm/system-prompt.ts")

  const sysBase =
    typeof loaderAny?.systemPromptBase === "function" ? loaderAny.systemPromptBase() : undefined
  const hasBodyExtras = Boolean(sessionContextForHash || afterInstructionsForHash)
  const systemForHash = hasBodyExtras
    ? JSON.stringify(
        resolveSystemPromptForModel(selectedModelBase, {
          afterInstructions: afterInstructionsForHash ?? undefined,
          sessionContext: sessionContextForHash ?? undefined,
          authKind: auth.type === "provider" ? auth.auth.kind : auth.type,
          ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
          cacheTtl,
          overrides: systemPromptOverrides,
          ...(sysBase ? { systemPromptBase: sysBase } : {}),
        }),
      )
    : ""

  // Same text as the registry adapter: explicit providers, else the loader's.
  const textProviders =
    toolTextProviders ??
    (loader && typeof loader.toolTextProviders === "function" ? loader.toolTextProviders() : [])
  const builtins = buildToolDefinitions(textProviders)
  const allToolsForHash = loader
    ? [...builtins, ...(loader.getExtraTools() as ToolDefinition[])]
    : builtins
  // Same pure policy as Agent / AgentCore advertisement — resume drift
  // compares tools the model actually sees.
  const toolsAdvertised = applyToolNamePolicy(allToolsForHash, toolNamePolicy)
  const toolsForHash = JSON.stringify(
    toolsAdvertised.map((t) => ({
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
